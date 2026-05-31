import { EventBus } from './core/EventBus.js';
import { StateStore } from './core/StateStore.js';
import { ApiClient } from './core/ApiClient.js';
import { I18n } from './core/I18n.js';
import { Toasts } from './core/Toasts.js';
import { LayoutManager } from './layout/LayoutManager.js';
import { PanelManager } from './layout/PanelManager.js';
import { EditorRegistry } from './editors/EditorRegistry.js';
import { codeEditorDescriptor } from './editors/CodeEditor.js';
import { markdownEditorDescriptor } from './editors/MarkdownEditor.js';
import { imageEditorDescriptor } from './editors/ImageEditor.js';
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
  registry.register(imageEditorDescriptor);
  registry.register(markdownEditorDescriptor);
  registry.register(codeEditorDescriptor);

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
        host, api, i18n,
        onOpen: (entry) => tabs.open(entry),
      });
      fileTree.refresh();
    },
  });
  bus.on('files:changed', () => fileTree?.refresh());

  if (boot.features?.git !== false && workspace.is_git) {
    panels.register('git', {
      label: i18n.t('git.title'), icon: 'fa fa-code-fork',
      mount: (host) => new GitPanel({ api, i18n, toasts, bus }).mount(host),
    });
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
  if (light) light.disabled = theme !== 'light';
  if (dark) dark.disabled = theme !== 'dark';
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
