import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const load = async path => {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
};
const source = await readFile(new URL('../public/js/editors/MergeEditor.js', import.meta.url), 'utf8');
const moduleSource = source
  .replace("'../core/EventBus.js'", JSON.stringify(await load('../public/js/core/EventBus.js')))
  .replace("'../core/Icon.js'", "'data:text/javascript,export const Icon = {}'")
  .replace("'../layout/Splitter.js'", "'data:text/javascript,export const attachSplitter = () => {}'")
  .replace("'./monacoLoader.js'", "'data:text/javascript,export const loadMonaco = () => {}'")
  .replace("'./DiffEditor.js'", "'data:text/javascript,export const detectLanguage = () => {}'");
const { parseConflicts, MergeEditor } = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);

test('conflict choices preserve CRLF, surrounding automatic merges and empty sides', () => {
  const text = 'automatic\r\n<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> topic\r\nmiddle\r\n<<<<<<< HEAD\r\n=======\r\nadded\r\n>>>>>>> topic';
  const { conflicts, hasMarkers } = parseConflicts(text);
  assert.equal(hasMarkers, true);
  assert.equal(conflicts.length, 2);
  assert.equal(conflicts[0].startLine, 2);
  assert.equal(conflicts[0].ours, 'ours\r\n');
  assert.equal(conflicts[0].theirs, 'theirs\r\n');
  assert.equal(conflicts[1].ours, '');
  const result = text.slice(0, conflicts[1].start) + conflicts[1].ours + text.slice(conflicts[1].end);
  const first = parseConflicts(result).conflicts[0];
  assert.equal(result.slice(0, first.start) + first.theirs + result.slice(first.end), 'automatic\r\ntheirs\r\nmiddle\r\n');
});

test('diff3 and zdiff3 markers support custom widths and base choices', () => {
  const text = '<<<<<<<<< HEAD\nours\n||||||||| base\nancestor\n=========\ntheirs\n>>>>>>>>> topic\n';
  const { conflicts } = parseConflicts(text);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].base, 'ancestor\n');
  assert.equal(conflicts[0].ours + conflicts[0].theirs, 'ours\ntheirs\n');
  assert.equal(conflicts[0].end, text.length);
  assert.equal(parseConflicts('normal\nx ======= y\n').hasMarkers, false);
});

test('source titles match marker labels, shorten hashes and retain full tooltips', () => {
  const hash = 'abcdef0123456789abcdef0123456789abcdef01';
  const text = `<<<<<<<<< HEAD\r\nours\r\n||||||||| common ancestor\r\nbase\r\n=========\r\ntheirs\r\n>>>>>>>>> ${hash} (Incoming commit)\r\n`;
  const editor = Object.create(MergeEditor.prototype);
  editor._sourceLabels = parseConflicts(text).conflicts[0].labels;
  assert.deepEqual(editor._sourceLabels, { ours: 'HEAD', theirs: `${hash} (Incoming commit)`, base: 'common ancestor' });
  editor._t = name => ({ ours: 'Current (ours)', theirs: 'Incoming (theirs)', base: 'Base (common ancestor)' })[name];
  editor._panes = Object.fromEntries(['ours', 'theirs', 'base'].map(name => [name, {
    title: {}, section: { setAttribute(key, value) { this[key] = value; } },
    editor: { updateOptions(options) { this.options = options; } },
  }]));
  editor._updateSourceTitles();
  assert.equal(editor._panes.ours.title.textContent, 'Current (ours), HEAD');
  assert.equal(editor._panes.theirs.title.textContent, 'Incoming (theirs), abcdef01 (Incoming commit)');
  assert.equal(editor._panes.theirs.title.title, `Incoming (theirs), ${hash} (Incoming commit)`);
  assert.equal(editor._panes.base.title.textContent, 'Base (common ancestor), common ancestor');
  assert.equal(editor._panes.theirs.editor.options.ariaLabel, editor._panes.theirs.section['aria-label']);
  editor.getContent = () => 'resolved result';
  editor._updateSourceTitles();
  assert.equal(editor._panes.ours.title.textContent, 'Current (ours), HEAD');
  editor._sourceLabels = {};
  editor._updateSourceTitles();
  assert.equal(editor._panes.ours.title.textContent, 'Current (ours)');
});

test('incomplete or partially edited markers still block completion', () => {
  for (const text of ['<<<<<<< HEAD\nours\n', '\uFEFF<<<<<<< HEAD\nours\n', '=======\n', '>>>>>>> topic\n', '||||||| base\n', '<<<<<<< HEAD\n=======\n>>>>>>>> wrong width\n']) {
    assert.equal(parseConflicts(text).hasMarkers, true);
    assert.equal(parseConflicts(text).conflicts.length, 0);
  }
});

test('accepting a block is undoable, leaves automatic changes intact, and ignores stale actions', () => {
  const editor = Object.create(MergeEditor.prototype);
  const text = 'auto\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\nend\n';
  const conflict = parseConflicts(text).conflicts[0];
  editor._conflicts = [conflict];
  const edits = [];
  editor._edit = (...args) => edits.push(args);
  editor._accept(conflict, 'both');
  assert.deepEqual(edits, [[conflict.start, conflict.end, 'ours\ntheirs\n']]);
  editor._conflicts = [{ ...conflict }];
  editor._accept(conflict, 'ours');
  editor._busy = true;
  editor._accept(editor._conflicts[0], 'theirs');
  assert.equal(edits.length, 1);
});

test('save snapshots use the conflict endpoint and advance the token only after success', async () => {
  const editor = Object.create(MergeEditor.prototype);
  const requests = [];
  editor._token = 'original-token';
  editor._updateControls = editor._update = () => {};
  editor._t = value => value;
  editor.ctx = { api: { put: async (...args) => {
    requests.push(args);
    return { token: 'saved-token', resolved: false };
  } } };
  await editor.saveSnapshot({ path: 'file.txt', content: '<<<<<<< HEAD\n', completeMerge: false, deleted: false });
  assert.equal(editor._token, 'saved-token');
  assert.equal(requests[0][0], '/git/conflict');
  await assert.rejects(editor.saveSnapshot({ content: '<<<<<<< HEAD\n', completeMerge: true, deleted: false }), /markers_remain/);
  assert.equal(requests.length, 1);
  editor.ctx.api.put = async () => { throw new Error('stale'); };
  await assert.rejects(editor.saveSnapshot({ content: 'result', completeMerge: true }), /stale/);
  assert.equal(editor._token, 'saved-token');
  assert.equal(editor._busy, false);
});

test('acknowledging a snapshot does not clean later edits or deletion choices', () => {
  const editor = Object.create(MergeEditor.prototype);
  editor._ready = true;
  editor._bus = { emit() {} };
  editor.getContent = () => 'later edit';
  editor.getSavePayload = () => ({ content: editor.getContent(), deleted: editor._deleted });
  editor._deleted = false;
  editor.markClean({ content: 'saved', deleted: false });
  assert.equal(editor.isDirty(), true);
  editor.markClean({ content: 'later edit', deleted: false });
  assert.equal(editor.isDirty(), false);
  editor._deleted = true;
  assert.equal(editor.isDirty(), true);
});

test('merge saves retain the result BOM without including it in edit offsets', () => {
  const editor = Object.create(MergeEditor.prototype);
  editor._panes = { result: { model: { getValue: (eol, preserveBOM) => (preserveBOM ? '\uFEFF' : '') + 'result\n' } } };
  editor._deleted = false;
  assert.equal(editor.getContent(), 'result\n');
  assert.equal(editor.getSavePayload().content, '\uFEFFresult\n');
});

const panelSource = await readFile(new URL('../public/js/git/GitPanel.js', import.meta.url), 'utf8');
const { GitPanel } = await import(`data:text/javascript;base64,${Buffer.from(panelSource
  .replace("'../core/Icon.js'", "'data:text/javascript,export const Icon = {render:()=>document.createElement(\"span\")}'")
  .replace("'../core/PopupMenu.js'", "'data:text/javascript,export const PopupMenu = {}'")
  .replace("'./GitToasts.js'", JSON.stringify(await load('../public/js/git/GitToasts.js')))).toString('base64')}`);

test('conflicting Git rows load the merge editor while normal rows keep their diff', async () => {
  const calls = [];
  const panel = Object.create(GitPanel.prototype);
  panel.api = { get: async (...args) => { calls.push(args); return { token: 'test' }; } };
  panel.onOpenMerge = (...args) => calls.push(args);
  panel._openDiff = (...args) => calls.push(['diff', ...args]);
  panel.toasts = { error: message => calls.push(['error', message]) };
  await panel._openChange({ path: 'conflict.txt', conflict: true }, 'changes');
  await panel._openChange({ path: 'normal.txt', conflict: false }, 'staged');
  assert.deepEqual(calls, [
    ['/git/conflict', { path: 'conflict.txt' }],
    ['conflict.txt', { token: 'test' }],
    ['diff', 'normal.txt', true],
  ]);
  panel.api.get = async () => { throw new Error('Conflict changed'); };
  await panel._openChange({ path: 'conflict.txt', conflict: true }, 'changes');
  assert.deepEqual(calls.at(-1), ['error', 'Conflict changed']);
});

const tabSource = await readFile(new URL('../public/js/editors/TabManager.js', import.meta.url), 'utf8');
const queueUrl = await load('../public/js/editors/SaveQueue.js');
const { SaveQueue } = await import(queueUrl);
const { TabManager } = await import(`data:text/javascript;base64,${Buffer.from(tabSource
  .replace("'../core/Icon.js'", "'data:text/javascript,export const Icon = {}'")
  .replace("'../core/PopupMenu.js'", "'data:text/javascript,export const PopupMenu = {}'")
  .replace("'./SaveQueue.js'", JSON.stringify(queueUrl))).toString('base64')}`);

function mergeTabs() {
  const writes = [];
  const messages = [];
  const tabs = Object.create(TabManager.prototype);
  const editor = {
    getSavePayload: () => ({ content: 'reviewed', deleted: false }),
    saveSnapshot: async snapshot => writes.push(snapshot),
    markClean() {},
    isDirty: () => false,
  };
  tabs.api = { workspace: 'repo', put: () => { throw new Error('Merge must not use files/write'); } };
  tabs.saveQueue = new SaveQueue();
  tabs.failedSaves = new Map();
  tabs.i18n = { t: key => key };
  tabs.toasts = { success: message => messages.push(message), error: message => messages.push(message) };
  tabs.bus = { emit() {} };
  tabs._scheduleOverflowUpdate = () => {};
  const record = {
    entry: { path: 'file.txt' }, editor, isMerge: true, dirty: true,
    tabEl: { classList: { toggle() {} } }, dirtyBtn: { style: {} },
  };
  tabs.tabs = new Map([['merge:file.txt', record]]);
  return { tabs, writes, messages, record };
}

test('tab saves serialize merge snapshots and pass explicit completion through the custom writer', async () => {
  const { tabs, writes, record } = mergeTabs();
  await tabs.save('merge:file.txt');
  await tabs.save('merge:file.txt', { completeMerge: true });
  assert.deepEqual(writes.map(snapshot => [snapshot.path, snapshot.content, snapshot.completeMerge]), [
    ['file.txt', 'reviewed', false],
    ['file.txt', 'reviewed', true],
  ]);
  assert.equal(record.savedContent, 'reviewed');
  assert.equal(record.dirty, false);
});

test('only successful completion advances the active merge to the next unresolved path', async () => {
  const { tabs, record, messages } = mergeTabs();
  tabs.active = 'merge:file.txt';
  const requests = [];
  const opened = [];
  tabs.openDiff = options => opened.push(options);
  tabs.api.get = async (endpoint, query) => {
    requests.push([endpoint, query]);
    return endpoint === '/git/status' ? { files: [
      { path: 'before.txt', conflict: true }, { path: 'file.txt', staged: true },
      { path: 'next.txt', conflict: true }, { path: 'normal.txt', changed: true },
    ] } : { token: 'next-conflict' };
  };
  await tabs.save('merge:file.txt');
  assert.equal(requests.length, 0);
  await tabs.save('merge:file.txt', { completeMerge: true });
  assert.deepEqual(opened, [{ path: 'next.txt', mergeData: { token: 'next-conflict' } }]);
  assert.deepEqual(requests, [['/git/status', undefined], ['/git/conflict', { path: 'next.txt' }]]);
  record.editor.saveSnapshot = async () => { throw new Error('save failed'); };
  await tabs.save('merge:file.txt', { completeMerge: true });
  assert.equal(opened.length, 1);
  assert.equal(messages.at(-1), 'save failed');
});

test('completion wraps to the first conflict and stays put after the last file', async () => {
  const { tabs } = mergeTabs();
  tabs.active = 'merge:file.txt';
  const opened = [];
  tabs.openDiff = options => opened.push(options);
  tabs.api.get = async endpoint => endpoint === '/git/status'
    ? { files: [{ path: 'before.txt', conflict: true }] } : { token: 'first' };
  await tabs.save('merge:file.txt', { completeMerge: true });
  assert.equal(opened[0].path, 'before.txt');
  tabs.api.get = async () => ({ files: [] });
  await tabs.save('merge:file.txt', { completeMerge: true });
  assert.equal(opened.length, 1);
  assert.equal(tabs.active, 'merge:file.txt');
});

test('completion does not steal focus when tabs change during either navigation request', async () => {
  for (const switchAt of ['/git/status', '/git/conflict']) {
    const { tabs } = mergeTabs();
    tabs.active = 'merge:file.txt';
    const opened = [];
    tabs.openDiff = options => opened.push(options);
    tabs.api.get = async endpoint => {
      if (endpoint === switchAt) tabs.active = 'other.txt';
      return endpoint === '/git/status' ? { files: [{ path: 'next.txt', conflict: true }] } : { token: 'next' };
    };
    await tabs.save('merge:file.txt', { completeMerge: true });
    assert.equal(opened.length, 0);
  }
});

test('next-file loading errors are shown without undoing a successful save', async () => {
  const { tabs, record, messages } = mergeTabs();
  tabs.active = 'merge:file.txt';
  tabs.api.get = async () => { throw new Error('Cannot load next conflict'); };
  await tabs.save('merge:file.txt', { completeMerge: true });
  assert.equal(record.savedContent, 'reviewed');
  assert.equal(record.dirty, false);
  assert.equal(messages.at(-1), 'Cannot load next conflict');
});

test('merge saves cannot overwrite a dirty sibling tab for the same file', async () => {
  const { tabs, writes, messages } = mergeTabs();
  tabs.tabs.set('file.txt', { entry: { path: 'file.txt' }, dirty: true });
  await tabs.save('merge:file.txt', { completeMerge: true });
  assert.equal(writes.length, 0);
  assert.deepEqual(messages, ['merge.other_dirty']);
});

test('opening a new conflict reloads a clean merge tab but preserves unsaved work', () => {
  const { tabs, record } = mergeTabs();
  const loads = [];
  record.editor.load = data => loads.push(data);
  tabs.activate = () => {};
  const mergeData = { token: 'new-conflict' };
  tabs.openDiff({ path: 'file.txt', mergeData });
  assert.equal(loads.length, 0);
  record.dirty = false;
  tabs.openDiff({ path: 'file.txt', mergeData });
  assert.deepEqual(loads, [{ token: 'new-conflict', path: 'file.txt' }]);
});

function domElement(tag = 'div') {
  const classes = new Set();
  return {
    tag, children: [], style: {}, value: '', _text: '',
    classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      contains: name => classes.has(name),
    },
    setAttribute(name, value) { this[name] = value; },
    append(...nodes) { this.children.push(...nodes); },
    prepend(...nodes) { this.children.unshift(...nodes); },
    appendChild(node) { this.append(node); },
    replaceChildren(...nodes) { this.children = nodes; this._text = ''; },
    addEventListener(name, callback) { this[`on${name}`] = callback; },
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); },
    set textContent(value) { this._text = value; this.children = []; },
    set innerHTML(value) { this.replaceChildren(); },
  };
}

function operationPanel(type = 'merge', ready = false) {
  globalThis.document = { createElement: domElement, createTextNode: text => ({ textContent: text }), activeElement: null };
  const calls = { posts: [], events: [], errors: [], refreshes: 0 };
  const panel = new GitPanel({
    api: { post: async (path, body) => { calls.posts.push({ path, body }); return {}; } },
    bus: { on() {}, emit: (...args) => calls.events.push(args) },
    i18n: { t: key => key },
    toasts: { success() {}, error: message => calls.errors.push(message) },
  });
  panel._lastStatus = panel._normalizeStatus({
    operation: type ? { type, ready, token: 'operation-token', message: 'Original message' } : null,
    files: ready ? [] : [{ path: 'conflict.txt', conflict: true, staged: false, changed: true }],
  });
  for (const name of ['commitBtn', 'amendBtn', 'pushBtn', 'pullBtn', 'mergeWorktreeBtn', 'operationNotice', 'msg', 'body']) panel[name] = domElement();
  panel.refresh = async () => { calls.refreshes++; };
  panel._showGitError = error => calls.errors.push(error.message);
  return { panel, calls };
}

test('conflicts occupy the first group exclusively, preserving normal staged/working duplication', () => {
  const { panel } = operationPanel();
  panel._collapsed = {};
  panel._buildFilter = () => domElement();
  panel._restoreFilterFocus = () => {};
  const rows = [];
  panel._renderFile = (file, group) => { rows.push([file.path, group]); return domElement(); };
  panel.render(panel._normalizeStatus({ files: [
    { path: 'conflict.txt', conflict: true, staged: true, changed: true },
    { path: 'partial.txt', staged: true, changed: true },
    { path: 'new.txt', untracked: true },
  ] }));
  assert.deepEqual(rows, [
    ['conflict.txt', 'conflicts'], ['partial.txt', 'staged'], ['partial.txt', 'changed'], ['new.txt', 'untracked'],
  ]);
  assert.match(panel.body.textContent, /git\.conflicts \(1\)/);
  assert.equal(panel._buildStatusDescriptor({ conflict: true }).code, '!');
  const conflictHeader = panel.body.children.find(node => node.className === 'git-group-header');
  assert.equal(conflictHeader.children.filter(node => node.tag === 'button').length, 0, 'No bulk stage/discard shortcut can bypass conflict resolution');
});

for (const type of ['merge', 'cherry-pick']) {
  test(`${type} warns during conflicts, then promotes only Commit after the final resolution`, () => {
    const { panel } = operationPanel(type);
    panel.pushBtn.classList.add('primary');
    panel._updateCommitButton(panel._lastStatus);
    panel._updateOperationNotice(panel._lastStatus);
    assert.equal(panel.commitBtn.disabled, true);
    assert.equal(panel.commitBtn.classList.contains('primary'), false);
    assert.equal(panel.amendBtn.disabled, true);
    assert.equal(panel.operationNotice.hidden, false);
    assert.match(panel.operationNotice.textContent, new RegExp(`git\\.${type}_conflicts`));
    assert.equal(panel.msg.readOnly, type === 'cherry-pick');
    panel._lastStatus.files = [];
    panel._lastStatus.operation.ready = true;
    panel._updateCommitButton(panel._lastStatus);
    panel._updateOperationNotice(panel._lastStatus);
    assert.equal(panel.commitBtn.disabled, false);
    assert.equal(panel.commitBtn.classList.contains('primary'), true);
    assert.equal(panel.commitBtn.textContent, `git.commit_${type}`);
    assert.equal(panel.pushBtn.classList.contains('primary'), false);
    assert.match(panel.operationNotice.textContent, new RegExp(`git\\.${type}_ready`));
    panel._lastStatus.operation = null;
    panel._updateCommitButton(panel._lastStatus);
    panel._updateOperationNotice(panel._lastStatus);
    assert.equal(panel.operationNotice.hidden, true);
    assert.equal(panel.msg.readOnly, false);
    assert.equal(panel.commitBtn.classList.contains('primary'), false);
  });

  test(`${type} completion uses its operation token and refreshes after failure too`, async () => {
    const { panel, calls } = operationPanel(type, true);
    panel.msg.value = 'Reviewed message';
    await panel.commit(false);
    assert.deepEqual(calls.posts, [{ path: '/git/finish-operation', body: { token: 'operation-token', abort: false, message: 'Reviewed message' } }]);
    assert.equal(calls.refreshes, 1);
    panel.api.post = async () => { throw new Error('continuation stopped'); };
    await panel.commit(false);
    assert.deepEqual(calls.errors, ['continuation stopped']);
    assert.equal(calls.refreshes, 2);
    assert.equal(panel._finishingOperation, false);
  });

  test(`${type} abort requires confirmation and only closes tabs after successful abort`, async () => {
    const { panel, calls } = operationPanel(type);
    globalThis.window = { confirm: () => false };
    await panel.abortOperation();
    assert.equal(calls.posts.length, 0);
    window.confirm = () => true;
    await panel.abortOperation();
    assert.deepEqual(calls.posts, [{ path: '/git/finish-operation', body: { token: 'operation-token', abort: true } }]);
    assert.ok(calls.events.some(([name]) => name === 'git:operation-aborted'));
    calls.events = [];
    panel.api.post = async () => { throw new Error('abort failed'); };
    await panel.abortOperation();
    assert.deepEqual(calls.errors, ['abort failed']);
    assert.equal(calls.events.length, 0);
    assert.equal(calls.refreshes, 2);
  });
}

test('committing or amending unresolved conflicts never sends a request', async () => {
  const { panel, calls } = operationPanel();
  await panel.commit(false);
  await panel.commit(true);
  assert.equal(calls.posts.length, 0);
  assert.equal(calls.errors.length, 2);
});

test('confirmed abort closes stale merge/diff views but keeps unrelated and dirty regular tabs', () => {
  const tabs = Object.create(TabManager.prototype);
  tabs.tabs = new Map([
    ['merge:old.txt', { isMerge: true, entry: { path: 'old.txt' }, dirty: true }],
    ['diff:file.txt', { isDiff: true, entry: { path: 'file.txt' }, dirty: true }],
    ['file.txt', { entry: { path: 'file.txt' }, dirty: true }],
    ['clean.txt', { entry: { path: 'clean.txt' }, dirty: false }],
    ['unrelated.txt', { entry: { path: 'unrelated.txt' }, dirty: false }],
  ]);
  tabs._closeRecord = (key, options) => {
    assert.equal(options.skipPrompt, true);
    tabs.tabs.delete(key);
  };
  tabs.closeAbortedOperation(['file.txt', 'clean.txt']);
  assert.deepEqual([...tabs.tabs.keys()], ['file.txt', 'unrelated.txt']);
});

const historySource = await readFile(new URL('../public/js/git/HistoryPanel.js', import.meta.url), 'utf8');
const { HistoryPanel } = await import(`data:text/javascript;base64,${Buffer.from(historySource
  .replace("'../core/Icon.js'", "'data:text/javascript,export const Icon = {}'")
  .replace("'../core/PopupMenu.js'", "'data:text/javascript,export const PopupMenu = {}'")
  .replace("'../layout/Splitter.js'", "'data:text/javascript,export const attachSplitter = () => {}'")
  .replace("'./GitToasts.js'", JSON.stringify(await load('../public/js/git/GitToasts.js')))).toString('base64')}`);

test('failed merge/cherry-pick actions in history invalidate Git status to reveal conflict warnings', async () => {
  const events = [];
  const panel = Object.create(HistoryPanel.prototype);
  panel.api = { post: async () => { throw new Error('conflicts'); } };
  panel._showGitError = error => events.push(['error', error.message]);
  panel.bus = { emit: (...args) => events.push(args) };
  for (const operation of ['merge', 'cherry-pick']) {
    await panel._runCommitAction(`/git/${operation}`, {}, '', operation);
  }
  assert.deepEqual(events, [
    ['error', 'conflicts'], ['git:branch-changed', {}],
    ['error', 'conflicts'], ['git:branch-changed', {}],
  ]);
});
