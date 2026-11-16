import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const load = source => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const { ApiClient } = await load(await readFile(new URL('../public/js/core/ApiClient.js', import.meta.url), 'utf8'));
const iconSource = await readFile(new URL('../public/js/core/Icon.js', import.meta.url), 'utf8');
const selectorSource = (await readFile(new URL('../public/js/git/WorktreeSelector.js', import.meta.url), 'utf8'))
  .replace("import { Icon } from '../core/Icon.js';", iconSource.replace('export const Icon', 'const Icon'))
  .replace(/^import .*;\r?\n/gm, '');
const { WorktreeSelector } = await load(selectorSource);
const panelSource = (await readFile(new URL('../public/js/git/GitPanel.js', import.meta.url), 'utf8'))
  .replace("import { Icon } from '../core/Icon.js';", iconSource.replace('export const Icon', 'const Icon'))
  .replace(/^import .*;\r?\n/gm, '');
const { GitPanel } = await load(panelSource);

function selector(worktree = null) {
  return Object.assign(Object.create(WorktreeSelector.prototype), {
    boot: { worktree, workspace_path: 'axenox.IDE' },
    i18n: { t: key => key },
    api: { base: '/host/api/ide/codiware' },
    canSwitch: () => true,
    el: { style: {} },
  });
}

test('all API URLs include the selected worktree, including repeated download paths', () => {
  const api = new ApiClient('/codiware', 'sample/repo', 'external tree');
  const url = new URL(api.url('/files/download', { 'paths[]': ['one.txt', 'two.txt'] }), 'http://localhost');
  assert.equal(url.searchParams.get('root'), 'sample/repo');
  assert.equal(url.searchParams.get('worktree'), 'external tree');
  assert.deepEqual(url.searchParams.getAll('paths[]'), ['one.txt', 'two.txt']);
  assert.equal(new URL(new ApiClient('/codiware', 'sample/repo').url('/git/status'), url).searchParams.has('worktree'), false);
});

test('selector stays hidden for main-only repos and appears with linked worktrees', async () => {
  const control = selector();
  control.api.get = async () => [{ main: true }];
  await control.refresh();
  assert.equal(control.el.style.display, 'none');
  control.api.get = async () => [{ main: true }, { title: 'feature', main: false }];
  await control.refresh();
  assert.equal(control.el.style.display, '');
});

test('worktree menu prevents deleting main/current/locked/missing trees', () => {
  const control = selector('active');
  const items = control.menuItems([
    { main: true },
    { title: 'active' },
    { title: 'locked', locked: true },
    { title: 'missing', missing: true },
    { title: 'other' },
  ]);
  assert.deepEqual(items.slice(0, 5).map(item => Boolean(item.children[1].disabled)), [true, true, true, true, false]);
  assert.equal(items[1].children[0].disabled, true);
  assert.equal(items[3].children[0].disabled, true);
  assert.equal(items.at(-1).label, 'git.create_worktree');
});

test('current worktree entries use the same indicator as the current branch', () => {
  const panel = new GitPanel({ bus: { on() {} }, i18n: { t: key => key } });
  const branch = panel._branchMenuItems({ locals: ['active'] }, 'active').find(item => item.children);
  const trees = [{ main: true }, { title: 'active' }, { title: 'other' }];
  const linkedItems = selector('active').menuItems(trees);
  const mainItems = selector().menuItems(trees);
  assert.equal(linkedItems[1].icon, branch.icon);
  assert.equal(mainItems[0].icon, branch.icon);
  assert.notEqual(linkedItems[2].icon, branch.icon);
});

test('branch chooser nests the shared worktree entries and their actions instead of opening another menu', () => {
  const control = selector('active');
  const worktreeItems = control.menuItems([{ main: true }, { title: 'active' }, { title: 'other' }]);
  const panel = new GitPanel({
    bus: { on() {} },
    i18n: control.i18n,
    onGetWorktreeMenuItems: async () => worktreeItems,
  });
  const items = panel._branchMenuItems({ locals: ['main'] }, 'main', worktreeItems);
  const entry = items.find(item => !item.heading && item.label === 'git.worktrees');
  assert.equal(entry.onClick, undefined);
  assert.equal(entry.children, worktreeItems);
  assert.equal(entry.children[1].children[0].disabled, true);
  let switched;
  control.switchTo = title => { switched = title; };
  entry.children[2].children[0].onClick();
  assert.equal(switched, 'other');
});

test('branch chooser worktree submenu still offers creation when no linked worktrees exist', () => {
  const control = selector();
  const worktreeItems = control.menuItems([{ main: true }]);
  const panel = new GitPanel({
    bus: { on() {} },
    i18n: control.i18n,
    onGetWorktreeMenuItems: async () => worktreeItems,
  });
  const entry = panel._branchMenuItems({}, null, worktreeItems).find(item => !item.heading && item.label === 'git.worktrees');
  let created = false;
  control.createWorktree = () => { created = true; };
  entry.children.at(-1).onClick();
  assert.equal(created, true);
});

test('branch chooser orders creation, branch groups, and the worktree section', () => {
  const panel = new GitPanel({
    bus: { on() {} },
    i18n: { t: key => key },
    onCreateWorktree() {},
    onGetWorktreeMenuItems: async () => [],
  });
  const describe = items => items.map(item => item.sep ? '---' : (item.heading ? 'heading:' : '') + item.label);
  assert.deepEqual(describe(panel._branchMenuItems({ locals: ['feature'], remotes: ['origin/main'] }, null)), [
    'git.create_branch', '---',
    'heading:git.local_branches', 'feature', '---',
    'heading:git.remote_branches', 'origin/main', '---',
    'heading:git.worktrees', 'git.create_worktree', 'git.worktrees',
  ]);
  assert.deepEqual(describe(panel._branchMenuItems({}, null)), [
    'git.create_branch', '---', 'heading:git.worktrees', 'git.create_worktree', 'git.worktrees',
  ]);
});

test('switching preserves the host app alias and unrelated params, never replays branch checkout', () => {
  let assigned;
  globalThis.window = { location: {
    href: 'http://localhost/host/api/ide/codiware/repo/axenox.IDE?branch=other&worktree=old&theme=dark',
    assign: href => { assigned = new URL(href); },
  } };
  const control = selector();
  control.boot.workspace_path = 'axenox\\IDE';
  control.switchTo('external tree');
  assert.equal(assigned.pathname, '/host/api/ide/codiware/repo/axenox.IDE/worktrees/external%20tree/');
  assert.equal(assigned.search, '?theme=dark');
  window.location.href = assigned.href;
  control.switchTo('another-tree');
  assert.equal(assigned.pathname, '/host/api/ide/codiware/repo/axenox.IDE/worktrees/another-tree/');
  window.location.href = assigned.href;
  control.switchTo(null);
  assert.equal(assigned.pathname, '/host/api/ide/codiware/repo/axenox.IDE');
  assigned = null;
  control.canSwitch = () => false;
  control.switchTo('cancelled');
  assert.equal(assigned, null);
});

test('switching preserves encoded nested repository URL paths instead of normalized boot paths', () => {
  let assigned;
  globalThis.window = { location: {
    href: 'http://localhost/host/api/ide/codiware/repo/vendor/app%20name/worktrees/old/',
    assign: href => { assigned = new URL(href); },
  } };
  const control = selector('old');
  control.boot.workspace_path = 'vendor\\app name';
  control.switchTo('new #tree');
  assert.equal(assigned.pathname, '/host/api/ide/codiware/repo/vendor/app%20name/worktrees/new%20%23tree/');
  window.location.href = assigned.href;
  control.switchTo(null);
  assert.equal(assigned.pathname, '/host/api/ide/codiware/repo/vendor/app%20name');
});

test('Open main checkout preserves the ExFace app URL when the boot path is a namespace', () => {
  let assigned;
  globalThis.window = { location: {
    href: 'http://localhost/exface/exface/api/ide/codiware/repo/axenox.Markian/worktrees/delete-button-hover-toolbar-codeblock/?branch=other&worktree=old&theme=dark',
    assign: href => { assigned = new URL(href); },
  } };
  const control = selector('delete-button-hover-toolbar-codeblock');
  control.api.base = '/exface/exface/api/ide/codiware';
  control.boot.workspace_path = 'axenox\\Markian';
  const panel = new GitPanel({
    bus: { on() {} },
    i18n: control.i18n,
    onOpenMainCheckout: () => control.switchTo(null),
  });
  panel.onOpenMainCheckout();
  assert.equal(assigned.pathname, '/exface/exface/api/ide/codiware/repo/axenox.Markian');
  assert.equal(assigned.search, '?theme=dark');
});

function toolbarButton() {
  const classes = new Set();
  const button = {
    classList: {
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
    },
    children: [],
    append(child) { this.children.push(child); child.remove = () => this.children.splice(this.children.indexOf(child), 1); },
    querySelector() { return this.children.find(child => child.className === 'tb-btn-label'); },
    setAttribute(name, value) { this[name] = value; },
  };
  return button;
}

test('one own commit promotes merge instead of push, then restores push after integration', () => {
  globalThis.document = { createElement: () => ({}) };
  const panel = new GitPanel({ bus: { on() {} }, i18n: { t: key => key } });
  panel.pushBtn = toolbarButton();
  panel.mergeWorktreeBtn = toolbarButton();
  const render = merge => {
    const status = panel._normalizeStatus({ unpublished: true, worktree_merge: merge });
    panel._updatePushButton(status);
    panel._updateWorktreeMergeButton(status);
  };
  render({ commits: 0 });
  assert.equal(panel.pushBtn.classList.contains('primary'), true);
  assert.equal(panel.mergeWorktreeBtn.classList.contains('primary'), false);
  assert.equal(panel.mergeWorktreeBtn.disabled, true);
  render({ commits: 1 });
  assert.equal(panel.pushBtn.classList.contains('primary'), false);
  assert.equal(panel.mergeWorktreeBtn.classList.contains('primary'), true);
  assert.equal(panel.mergeWorktreeBtn.querySelector().textContent, 'git.merge_worktree (1)');
  assert.equal(panel.mergeWorktreeBtn.title, 'git.merge_worktree_tooltip');
  assert.equal(panel.mergeWorktreeBtn.disabled, false);
  render({ commits: 1, blocked_reason: 'main_dirty' });
  assert.equal(panel.mergeWorktreeBtn.disabled, true);
  assert.match(panel.mergeWorktreeBtn.title, /git\.merge_worktree_main_dirty/);
  assert.match(panel.mergeWorktreeBtn.title, /^git\.merge_worktree_tooltip\n/);
  render({ commits: 0 });
  assert.equal(panel.pushBtn.classList.contains('primary'), true);
  assert.equal(panel.mergeWorktreeBtn.classList.contains('primary'), false);
  assert.equal(panel.mergeWorktreeBtn.children.length, 0);
  assert.equal(panel.mergeWorktreeBtn.title, 'git.merge_worktree_tooltip\ngit.merge_worktree_empty');
});

function mergePanel(merge, { confirmed = true, failure = null } = {}) {
  const calls = { posts: [], success: [], errors: [], notices: [], confirmations: [], refreshed: 0 };
  globalThis.window = { confirm: message => { calls.confirmations.push(message); return confirmed; } };
  const panel = new GitPanel({
    api: {
      worktree: 'feature-tree',
      get: async () => ({ branch: 'feature', worktree_merge: merge }),
      post: async (path, body) => {
        calls.posts.push({ path, body });
        if (failure) throw failure;
        return { commits: merge.commits, branch: merge.target_branch };
      },
    },
    bus: { on() {}, emit() {} },
    i18n: { t: (key, values) => key + (values ? JSON.stringify(values) : '') },
    toasts: { success: message => calls.success.push(message), error: message => calls.errors.push(message) },
  });
  panel._applyStatus = status => { panel._lastStatus = panel._normalizeStatus(status); };
  panel._showMergeNotice = message => calls.notices.push(message);
  panel._showGitError = error => calls.errors.push(error.message);
  panel.refresh = async () => { calls.refreshed++; };
  return { panel, calls };
}

const pendingMerge = { commits: 2, source_head: 'source-sha', target_head: 'target-sha', target_branch: 'release' };

test('merge-back confirms the actual destination and sends the reviewed commit snapshot', async () => {
  const { panel, calls } = mergePanel(pendingMerge);
  await panel.mergeWorktree();
  assert.match(calls.confirmations[0], /"count":2,"source":"feature","target":"release"/);
  assert.deepEqual(calls.posts, [{
    path: '/git/merge-worktree',
    body: { source_head: 'source-sha', target_head: 'target-sha', target_branch: 'release' },
  }]);
  assert.equal(calls.success.length, 1);
  assert.equal(calls.refreshed, 1);
  assert.equal(panel._mergingWorktree, false);
});

test('cancelled or blocked merge-back never modifies the main checkout', async () => {
  const cancelled = mergePanel(pendingMerge, { confirmed: false });
  await cancelled.panel.mergeWorktree();
  assert.equal(cancelled.calls.posts.length, 0);
  const blocked = mergePanel({ ...pendingMerge, blocked_reason: 'main_busy' });
  await blocked.panel.mergeWorktree();
  assert.equal(blocked.calls.posts.length, 0);
  assert.equal(blocked.calls.confirmations.length, 0);
  assert.match(blocked.calls.notices[0], /git\.merge_worktree_main_busy/);
});

test('merge conflicts display guidance for the main checkout, never a success message', async () => {
  const { panel, calls } = mergePanel(pendingMerge, {
    failure: { code: 'worktree_merge_conflicts', message: 'Conflict', details: { open_main: true } },
  });
  await panel.mergeWorktree();
  assert.equal(calls.success.length, 0);
  assert.equal(calls.errors.length, 1);
  assert.equal(calls.notices[0], 'git.merge_worktree_conflicts');
  assert.equal(calls.refreshed, 1);
});

test('merge guidance includes a working Open main checkout action', () => {
  const children = [];
  globalThis.document = {
    createTextNode: text => ({ textContent: text }),
    createElement: () => ({ addEventListener(event, handler) { this[event] = handler; } }),
  };
  let opened = false;
  const panel = new GitPanel({
    bus: { on() {} },
    i18n: { t: key => key },
    onOpenMainCheckout: () => { opened = true; },
  });
  panel.mergeNotice = { hidden: true, replaceChildren: (...nodes) => { children.splice(0, children.length, ...nodes); }, append: node => children.push(node) };
  panel._showMergeNotice('Conflicts are in the main checkout.');
  assert.equal(panel.mergeNotice.hidden, false);
  assert.equal(children[1].textContent, 'git.open_main_checkout');
  children[1].click();
  assert.equal(opened, true);
});
