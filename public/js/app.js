import { EventBus } from './core/EventBus.js';
import { StateStore } from './core/StateStore.js';
import { ApiClient } from './core/ApiClient.js';
import { I18n } from './core/I18n.js';
import { Toasts } from './core/Toasts.js';
import { LayoutManager } from './layout/LayoutManager.js';
import { PanelManager } from './layout/PanelManager.js';
import { EditorRegistry } from './editors/EditorRegistry.js';
import { monacoEditorDescriptor } from './editors/MonacoEditor.js';
import { markdownEditorDescriptor } from './editors/MarkdownEditor.js';
import { imageEditorDescriptor } from './editors/ImageEditor.js';
import { diffEditorDescriptor } from './editors/DiffEditor.js';
import { TabManager } from './editors/TabManager.js';
import { FileTree } from './files/FileTree.js';
import { GitPanel } from './git/GitPanel.js';
import { SearchPanel } from './search/SearchPanel.js';
import { ConsolePanel } from './console/ConsolePanel.js';
import { Icon } from './core/Icon.js';

/**
 * Application bootstrap. The HTML shell sets `window.CODIWARE_BOOT` with
 * the per-request configuration before this module loads.
 */
async function main() {
  const boot = window.CODIWARE_BOOT || {};
  const basePath = (boot.base_path || '/codiware').replace(/\/$/, '');
  const workspace = boot.workspace || {};

  // Theme
  document.documentElement.dataset.theme = (boot.theme?.default) || 'light';
  applyTheme(document.documentElement.dataset.theme);

  const bus = new EventBus();
  const state = new StateStore({ workspace });
  const i18n = new I18n();
  const toasts = new Toasts();
  const api = new ApiClient(basePath, workspace.alias || '');
  const registry = new EditorRegistry();

  // Load translations.
  try {
    const data = await api.get('/translations/' + (boot.locale || 'en'));
    i18n.setMessages(data?.messages || {});
  } catch (e) { console.warn('[codiware] translations failed:', e); }

  // Default editor descriptors. Extensions can add more before or after.
  // Monaco is the catch-all default for any non-binary file (priority 0).
  // Specialized editors register with a higher priority for matching mime types.
  registry.register(imageEditorDescriptor);
  registry.register(markdownEditorDescriptor);
  registry.register(monacoEditorDescriptor);
  registry.register(diffEditorDescriptor);

  // Editor context (shared by all editors).
  const ctx = { api, i18n, bus, state, boot, editor: boot.editor || {} };

  // Build chrome.
  const root = document.getElementById('codiware-root');
  const layout = new LayoutManager(root, { i18n, state, bus });
  layout.build();
  layout.setWorkspaceLabel(workspace.label || workspace.alias || workspace.path || '');
  layout.setStatusLeft(workspace.alias || '', workspace.is_git ? 'fa fa-code-fork' : 'fa fa-folder');
  layout.setStatusRight(`Codiware • ${boot.user?.name || ''}`);

  // Tabs + panels
  const tabs = new TabManager({
    tabBar: layout.slots.editorTabs,
    host: layout.slots.editorHost,
    api, registry, ctx, i18n, toasts, bus,
  });

  const panels = new PanelManager({
    tabsEl: layout.slots.sidebarTabs,
    contentEl: layout.slots.sidebarContent,
    i18n,
  });

  // Files panel
  let fileTree;
  panels.register('files', {
    label: i18n.t('files.title'), icon: 'fa fa-folder',
    mount: (host) => {
      fileTree = new FileTree({
        host, api, i18n, toasts, bus,
        fileIcons: boot.file_icons || {},
        onOpen: (entry) => tabs.open(entry),
      });
      fileTree.refresh();
    },
  });
  bus.on('files:changed', () => fileTree?.refresh());

  // Auto-close editor tabs whose underlying file (or parent folder) was deleted.
  bus.on('files:changed', (payload) => {
    if (payload?.action === 'delete' && payload.path !== undefined) {
      tabs.closePath(payload.path);
    }
    if ((payload?.action === 'rename' || payload?.action === 'move') && payload.from !== undefined) {
      tabs.closePath(payload.from);
    }
  });

  if (boot.features?.git !== false && workspace.is_git) {
    let gitPanel;
    panels.register('git', {
      label: i18n.t('git.title'), icon: 'fa fa-code-fork',
      mount: (host) => {
        gitPanel = new GitPanel({
          api, i18n, toasts, bus,
          onOpenDiff: (path, staged, diffData) => tabs.openDiff({ path, staged, diffData }),
        });
        gitPanel.mount(host);
      },
      onActivate: ({ firstActivation }) => {
        if (!firstActivation) gitPanel?.refresh();
      },
    });

    const footerGit = createGitFooterStatus({
      api,
      i18n,
      repoName: workspace.alias || workspace.label || workspace.path || 'repo',
      onOpenPanel: () => panels.activate('git'),
    });
    const statusSep = document.createElement('span');
    statusSep.className = 'ide-status-sep';
    statusSep.textContent = '|';
    layout.slots.statusLeft.append(statusSep, footerGit.el);

    bus.on('file:saved', () => footerGit.refresh());
    bus.on('files:changed', () => footerGit.refresh());
    bus.on('git:status-updated', (status) => footerGit.updateFromStatus(status));
    window.addEventListener('focus', () => footerGit.refresh());
    window.setInterval(() => footerGit.refresh(), 30000);
    footerGit.refresh();
  }

  panels.register('search', {
    label: i18n.t('search.title'), icon: 'fa fa-search',
    mount: (host) => new SearchPanel({
      api, i18n, toasts, bus,
      onOpenLine: (path, line) => tabs.open({ path, name: path.split('/').pop() }).then(() => bus.emit('editor:goto', { path, line })),
    }).mount(host),
  });

  // Bottom console
  if (boot.features?.console !== false) {
    const consolePanel = new ConsolePanel({ api, i18n, toasts });
    consolePanel.mount(layout.slots.bottomPanel);
  }

  // Toolbar: theme toggle + console toggle + save
  const themeBtn = document.createElement('button');
  themeBtn.append(Icon.render('fa fa-adjust'));
  themeBtn.title = 'Toggle theme';
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    applyTheme(next);
  });
  const consoleBtn = document.createElement('button');
  consoleBtn.append(Icon.render('fa fa-terminal'));
  consoleBtn.title = i18n.t('console.title');
  consoleBtn.addEventListener('click', () => layout.toggleBottom(220));
  const saveBtn = document.createElement('button');
  saveBtn.append(Icon.render('fa fa-floppy-o'), withLabel(i18n.t('actions.save')));
  saveBtn.title = i18n.t('actions.save');
  saveBtn.addEventListener('click', () => tabs.saveActive());
  layout.slots.titleRight.append(saveBtn, consoleBtn, themeBtn);

  // Global save shortcut
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.shiftKey) {
      e.preventDefault();
      tabs.saveActive();
    }
  });

  // Expose minimal extension API on window for late-loading plugins.
  window.Codiware = {
    api, bus, state, i18n, toasts,
    registerEditor: (d) => registry.register(d),
    openFile: (entry) => tabs.open(entry),
  };
  bus.emit('app:ready');
}

function applyTheme(theme) {
  const light = document.getElementById('codiware-css-light');
  const dark = document.getElementById('codiware-css-dark');
  const toastuiDark = document.getElementById('codiware-css-toastui-dark');
  if (light) light.disabled = theme !== 'light';
  if (dark) dark.disabled = theme !== 'dark';
  if (toastuiDark) toastuiDark.disabled = theme !== 'dark';
}

function createGitFooterStatus({ api, i18n, repoName, onOpenPanel }) {
  const el = document.createElement('div');
  el.className = 'ide-status-git';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'ide-status-git-refresh';
  refreshBtn.title = i18n.t('actions.refresh');
  refreshBtn.setAttribute('aria-label', i18n.t('actions.refresh'));
  refreshBtn.append(Icon.render('fa fa-refresh'));

  const mainBtn = document.createElement('button');
  mainBtn.type = 'button';
  mainBtn.className = 'ide-status-git-main';
  mainBtn.title = i18n.t('git.title');
  mainBtn.setAttribute('aria-label', i18n.t('git.title'));
  mainBtn.append(Icon.render('fa fa-code-fork'));

  const repoEl = document.createElement('span');
  repoEl.className = 'ide-status-git-repo';
  repoEl.textContent = repoName;
  const aheadBehindEl = document.createElement('span');
  aheadBehindEl.className = 'ide-status-git-ab';
  const countsEl = document.createElement('span');
  countsEl.className = 'ide-status-git-counts';

  mainBtn.append(repoEl, aheadBehindEl, countsEl);
  el.append(refreshBtn, mainBtn);

  refreshBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    refresh();
  });
  mainBtn.addEventListener('click', () => onOpenPanel?.());

  function updateFromStatus(status) {
    if (!status) return;
    const counts = summarizeGitStatus(status);
    aheadBehindEl.textContent = `+${status.ahead || 0} -${status.behind || 0}`;
    countsEl.textContent = `M${counts.changed} D${counts.deleted} ?${counts.untracked} S${counts.staged}`;
    const title = [
      `${repoName}`,
      `Ahead: ${status.ahead || 0}  Behind: ${status.behind || 0}`,
      `${i18n.t('git.changes')}: ${counts.changed}`,
      `${i18n.t('git.deleted')}: ${counts.deleted}`,
      `${i18n.t('git.untracked')}: ${counts.untracked}`,
      `${i18n.t('git.staged')}: ${counts.staged}`,
      i18n.t('git.title'),
    ].join('\n');
    mainBtn.title = title;
  }

  async function refresh() {
    refreshBtn.classList.add('is-spinning');
    try {
      const status = await api.get('/git/status');
      updateFromStatus(status);
    } catch (e) {
      mainBtn.title = e?.message || 'Failed to refresh git status';
    } finally {
      refreshBtn.classList.remove('is-spinning');
    }
  }

  return { el, refresh, updateFromStatus };
}

function summarizeGitStatus(status) {
  const files = Array.isArray(status?.files) ? status.files : [];
  let staged = 0;
  let changed = 0;
  let deleted = 0;
  let untracked = 0;
  for (const file of files) {
    if (file?.staged) staged += 1;
    if (file?.untracked) {
      untracked += 1;
      continue;
    }
    const isDeleted = file?.index === 'D' || file?.worktree === 'D';
    if (isDeleted) {
      deleted += 1;
      continue;
    }
    if (file?.changed || (file?.worktree && file.worktree !== '.')) {
      changed += 1;
    }
  }
  return { staged, changed, deleted, untracked };
}

function withLabel(text) {
  const s = document.createElement('span');
  s.textContent = text;
  return s;
}

main().catch((e) => {
  console.error('[codiware] boot failed:', e);
  const root = document.getElementById('codiware-root');
  if (root) {
    root.innerHTML = '';
    const msg = document.createElement('div');
    msg.style.padding = '2rem';
    msg.style.color = '#c0392b';
    msg.textContent = 'Failed to start Codiware: ' + (e?.message || e);
    root.appendChild(msg);
  }
});
