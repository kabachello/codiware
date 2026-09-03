import './core/PopupMenu.js';

let Icon = null;

function withCacheBust(path) {
  const v = window.CODIWARE_BOOT?.cache_bust || '';
  if (!v) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}v=${encodeURIComponent(v)}`;
}

async function loadAppModules() {
  const [
    { EventBus },
    { StateStore },
    { SettingsStore },
    { ApiClient },
    { I18n },
    { Toasts },
    { LayoutManager },
    { PanelManager },
    { BottomPanelManager },
    { EditorRegistry },
    { monacoEditorDescriptor },
    { markdownEditorDescriptor },
    { imageEditorDescriptor },
    { diffEditorDescriptor },
    { TabManager },
    { FileTree },
    { GitPanel },
    { HistoryPanel },
    { SearchPanel },
    { ConsolePanel },
    { Icon: IconModule },
  ] = await Promise.all([
    import(withCacheBust('./core/EventBus.js')),
    import(withCacheBust('./core/StateStore.js')),
    import(withCacheBust('./core/SettingsStore.js')),
    import(withCacheBust('./core/ApiClient.js')),
    import(withCacheBust('./core/I18n.js')),
    import(withCacheBust('./core/Toasts.js')),
    import(withCacheBust('./layout/LayoutManager.js')),
    import(withCacheBust('./layout/PanelManager.js')),
    import(withCacheBust('./layout/BottomPanelManager.js')),
    import(withCacheBust('./editors/EditorRegistry.js')),
    import(withCacheBust('./editors/MonacoEditor.js')),
    import(withCacheBust('./editors/MarkdownEditor.js')),
    import(withCacheBust('./editors/ImageEditor.js')),
    import(withCacheBust('./editors/DiffEditor.js')),
    import(withCacheBust('./editors/TabManager.js')),
    import(withCacheBust('./files/FileTree.js')),
    import(withCacheBust('./git/GitPanel.js')),
    import(withCacheBust('./git/HistoryPanel.js')),
    import(withCacheBust('./search/SearchPanel.js')),
    import(withCacheBust('./console/ConsolePanel.js')),
    import(withCacheBust('./core/Icon.js')),
  ]);

  return {
    EventBus,
    StateStore,
    SettingsStore,
    ApiClient,
    I18n,
    Toasts,
    LayoutManager,
    PanelManager,
    BottomPanelManager,
    EditorRegistry,
    monacoEditorDescriptor,
    markdownEditorDescriptor,
    imageEditorDescriptor,
    diffEditorDescriptor,
    TabManager,
    FileTree,
    GitPanel,
    HistoryPanel,
    SearchPanel,
    ConsolePanel,
    Icon: IconModule,
  };
}

/**
 * Application bootstrap. The HTML shell sets `window.CODIWARE_BOOT` with
 * the per-request configuration before this module loads.
 */
async function main() {
  const {
    EventBus,
    StateStore,
    SettingsStore,
    ApiClient,
    I18n,
    Toasts,
    LayoutManager,
    PanelManager,
    BottomPanelManager,
    EditorRegistry,
    monacoEditorDescriptor,
    markdownEditorDescriptor,
    imageEditorDescriptor,
    diffEditorDescriptor,
    TabManager,
    FileTree,
    GitPanel,
    HistoryPanel,
    SearchPanel,
    ConsolePanel,
    Icon: LoadedIcon,
  } = await loadAppModules();
  Icon = LoadedIcon;

  const boot = window.CODIWARE_BOOT || {};
  const basePath = (boot.url_to_api || '/codiware').replace(/\/$/, '');
  const workspace = boot.workspace || {};

  // Persistent per-user settings (localStorage). Theme is stored globally,
  // i.e. shared across all workspaces; other settings may be stored per repo.
  const settings = new SettingsStore({ install: basePath, workspace: workspace.alias || '' });

  // Theme: prefer the user's saved choice, then the boot default, then light.
  const initialTheme = settings.getGlobal('theme') || (boot.theme?.default) || 'light';
  document.documentElement.dataset.theme = initialTheme;
  applyTheme(initialTheme);

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
  const ctx = { api, i18n, bus, state, boot, editor: boot.editor || {}, settings, toasts };

  // Build chrome.
  const root = document.getElementById('codiware-root');
  const layout = new LayoutManager(root, { i18n, state, bus, settings });
  layout.build();
  ensureBottomLayoutCompatibility(layout);
  ctx.layout = layout;
  layout.setWorkspaceLabel(workspace.label || workspace.alias || workspace.path || '');
  layout.setStatusLeft(workspace.alias || '', 'fa fa-folder-open');
  layout.setStatusRight(`Codiware IDE • ${boot.user?.name || ''}`);

  // Tabs + panels
  const tabs = new TabManager({
    tabBar: layout.slots.editorTabs,
    host: layout.slots.editorHost,
    api, registry, ctx, i18n, toasts, bus, settings,
  });

  const panels = new PanelManager({
    tabsEl: layout.slots.sidebarTabs,
    contentEl: layout.slots.sidebarContent,
    i18n,
    layout,
  });
  const bottomSlots = ensureBottomPanelSlots(layout);
  const bottomPanels = new BottomPanelManager({
    tabsEl: bottomSlots.tabsEl,
    contentEl: bottomSlots.contentEl,
    layout,
  });

  const bottomCollapseBtn = document.createElement('button');
  bottomCollapseBtn.type = 'button';
  bottomCollapseBtn.className = 'ide-bottom-collapse';
  const collapseLabel = i18n.t('actions.collapse');
  const expandLabel = i18n.t('actions.expand');
  const collapseTitle = collapseLabel && collapseLabel !== 'actions.collapse' ? collapseLabel : 'Collapse panel';
  const expandTitle = expandLabel && expandLabel !== 'actions.expand' ? expandLabel : 'Expand panel';

  const updateBottomToggleIcon = () => {
    const isCollapsed = layout.isBottomCollapsed();
    const title = isCollapsed ? expandTitle : collapseTitle;
    bottomCollapseBtn.title = title;
    bottomCollapseBtn.setAttribute('aria-label', title);
    bottomCollapseBtn.replaceChildren(Icon.render(isCollapsed ? 'fa fa-angle-up' : 'fa fa-angle-down'));
  };

  bottomCollapseBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (layout.isBottomCollapsed()) layout.expandBottom();
    else layout.collapseBottom();
    updateBottomToggleIcon();
  });
  bottomSlots.tabsEl.append(bottomCollapseBtn);
  new MutationObserver(() => updateBottomToggleIcon())
    .observe(layout.slots.bottomPanel, { attributes: true, attributeFilter: ['class'] });
  updateBottomToggleIcon();

  const sidebarCollapseBtn = document.createElement('button');
  sidebarCollapseBtn.type = 'button';
  sidebarCollapseBtn.className = 'ide-sidebar-collapse';

  const updateSidebarToggleIcon = () => {
    const isCollapsed = layout.isSidebarCollapsed();
    const title = isCollapsed ? expandTitle : collapseTitle;
    sidebarCollapseBtn.title = title;
    sidebarCollapseBtn.setAttribute('aria-label', title);
    sidebarCollapseBtn.replaceChildren(Icon.render(isCollapsed ? 'fa fa-angle-right' : 'fa fa-angle-left'));
  };

  sidebarCollapseBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (layout.isSidebarCollapsed()) layout.expandSidebar();
    else layout.collapseSidebar();
    updateSidebarToggleIcon();
  });
  layout.slots.sidebarTabs.append(sidebarCollapseBtn);
  new MutationObserver(() => updateSidebarToggleIcon())
    .observe(layout.root.querySelector('.ide-sidebar'), { attributes: true, attributeFilter: ['class'] });
  updateSidebarToggleIcon();

  const panelByRequestPath = (path) => {
    if (typeof path !== 'string') return null;
    if (path.startsWith('/git/')) return 'git';
    if (path.startsWith('/files/')) return 'files';
    if (path.startsWith('/search')) return 'search';
    return null;
  };

  api.setRequestObserver(({ phase, path }) => {
    const panelId = panelByRequestPath(path);
    if (!panelId) return;
    panels.setBusy(panelId, phase === 'start');
  });

  // Files panel
  let fileTree;
  panels.register('files', {
    label: i18n.t('files.title'), icon: 'fa fa-folder',
    mount: (host) => {
      fileTree = new FileTree({
        host, api, i18n, toasts, bus, settings,
        fileIcons: boot.file_icons || {},
        filterMinChars: boot.files?.filter_min_chars,
        onOpen: (entry) => tabs.open(entry),
      });
      fileTree.refresh();
    },
  });
  bus.on('files:changed', () => {
    if (fileTree?._suspendRefreshOnce) {
      fileTree._suspendRefreshOnce = false;
      return;
    }
    fileTree?.refresh();
  });

  // Auto-close editor tabs whose underlying file (or parent folder) was deleted.
  bus.on('files:changed', (payload) => {
    if (payload?.action === 'delete') {
      if (Array.isArray(payload.items)) {
        payload.items.forEach((item) => {
          if (item?.path !== undefined) tabs.closePath(item.path);
        });
      } else if (payload.path !== undefined) {
        tabs.closePath(payload.path);
      }
    }
    if (payload?.action === 'rename' || payload?.action === 'move') {
      if (Array.isArray(payload.items)) {
        payload.items.forEach((item) => {
          if (item?.from !== undefined) tabs.closePath(item.from);
        });
      } else if (payload.from !== undefined) {
        tabs.closePath(payload.from);
      }
    }
  });
  bus.on('git:file-discarded', (payload) => {
    if (payload?.path !== undefined) {
      tabs.closeDiffsForPath(payload.path);
    }
  });

  if (boot.features?.git !== false && workspace.is_git) {
    let gitPanel;
    let gitStatusInvalidated = false;
    const hasGitIdentity = typeof boot.user?.has_git_identity === 'boolean'
      ? boot.user.has_git_identity
      : Boolean((boot.user?.name || '').trim() && (boot.user?.email || '').trim());
    panels.register('git', {
      label: i18n.t('git.title'), icon: 'fa fa-code-fork',
      mount: (host) => {
        gitPanel = new GitPanel({
          api, i18n, toasts, bus,
          user: boot.user || {},
          hasGitIdentity,
          initialStatus: gitStatusInvalidated ? null : (boot.git?.initial_status || null),
          onOpenDiff: (path, staged, diffData) => tabs.openDiff({ path, staged, diffData }),
          onOpenHistory: () => bottomPanels.activate('history', { expand: true }),
          onOpenFile: (entry) => tabs.open(entry),
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
      onOpenBranchMenu: (anchor) => gitPanel?.openBranchMenu(anchor),
    });
    const statusSep = document.createElement('span');
    statusSep.className = 'ide-status-sep';
    statusSep.textContent = '|';
    layout.slots.statusLeft.append(statusSep, footerGit.el);

    bus.on('file:saved', () => footerGit.refresh());
    bus.on('files:changed', () => footerGit.refresh());
    bus.on('git:status-updated', (status) => footerGit.updateFromStatus(status));
    // History-panel actions such as "Create branch from commit" bypass the
    // Git sidebar UI but still change the same repository state. Invalidate the
    // boot status, refresh the mounted Git panel when possible and otherwise
    // refresh the footer directly so all visible branch indicators converge.
    bus.on('git:branch-changed', (payload) => {
      gitStatusInvalidated = true;
      if (payload?.status) {
        footerGit.updateFromStatus(payload.status);
        return;
      }
      if (gitPanel) {
        gitPanel.refresh();
        return;
      }
      footerGit.refresh();
    });
    window.addEventListener('focus', () => footerGit.refresh());
    window.setInterval(() => footerGit.refresh(), 30000);
    footerGit.refresh();

    const initialBranchSwitch = boot.git?.initial_branch_switch || null;
    if (initialBranchSwitch?.console) {
      bus.emit('console:inject', initialBranchSwitch.console);
    }
    if (initialBranchSwitch?.switched && initialBranchSwitch?.target) {
      toasts.success((i18n.t('git.switched_branch') || 'Switched to branch') + ` ${initialBranchSwitch.target}`);
    }
  }

  panels.register('search', {
    label: i18n.t('search.title'), icon: 'fa fa-search',
    mount: (host) => new SearchPanel({
      api, i18n, toasts, bus,
      onOpenLine: (path, line, column) => tabs.open(
        { path, name: path.split('/').pop() },
        { editorId: 'codiware.monaco', key: `search:${path}`, label: path.split('/').pop() }
      ).then(() => bus.emit('editor:goto', { path, line, column })),
    }).mount(host),
  });

  // Bottom tabs
  if (boot.features?.console !== false) {
    const consoleLabel = i18n.t('console.title');
    // Instantiate eagerly so the panel can subscribe to the bus and receive
    // injected output (e.g. from the Git panel) even before it is first opened.
    // The xterm terminal itself is created lazily on first mount.
    const consolePanel = new ConsolePanel({
      api, i18n, toasts, bus,
      open: () => bottomPanels.activate('console', { expand: true }),
    });
    bottomPanels.register('console', {
      label: consoleLabel && consoleLabel !== 'console.title' ? consoleLabel : 'Console',
      icon: 'fa fa-terminal',
      mount: (host) => consolePanel.mount(host),
    });
  }

  // Git history bottom tab (after Console). Contents load lazily on first open.
  if (boot.features?.git !== false && workspace.is_git) {
    let historyPanel;
    const historyLabel = i18n.t('history.title');
    bottomPanels.register('history', {
      label: historyLabel && historyLabel !== 'history.title' ? historyLabel : 'Git history',
      icon: 'fa fa-history',
      mount: (host) => {
        historyPanel = new HistoryPanel({
          api, i18n, toasts, bus,
          onOpenDiff: (opts) => tabs.openDiff(opts),
          onOpenFile: (entry) => tabs.open(entry),
        });
        historyPanel.mount(host);
      },
    });
    bus.on('git:open-file-history', ({ path } = {}) => {
      if (!path) return;
      bottomPanels.activate('history', { expand: true });
      historyPanel?.openFileHistory(path);
    });
  }

  // Toolbar: theme toggle + bottom panel toggle + save
  const themeBtn = document.createElement('button');
  themeBtn.append(Icon.render('fa fa-adjust'));
  themeBtn.title = 'Toggle theme';
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    applyTheme(next);
    settings.setGlobal('theme', next);
  });
  const saveBtn = document.createElement('button');
  saveBtn.append(Icon.render('fa fa-floppy-o'), withLabel(i18n.t('actions.save')));
  saveBtn.title = i18n.t('actions.save');
  saveBtn.addEventListener('click', () => tabs.saveActive());
  layout.slots.titleRight.append(saveBtn);
  layout.slots.titleRight.append(themeBtn);

  // Global save shortcut
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.shiftKey) {
      e.preventDefault();
      tabs.saveActive();
    }
  });

  // Expose minimal extension API on window for late-loading plugins.
  window.Codiware = {
    api, bus, state, settings, i18n, toasts,
    popupMenu: window.CodiwarePopupMenu,
    registerEditor: (d) => registry.register(d),
    openFile: (entry) => tabs.open(entry),
  };
  bus.emit('app:ready');

  // Reopen the file tabs that were open in the previous session for this
  // workspace. Diff tabs are intentionally not restored.
  tabs.restore();
}

function applyTheme(theme) {
  const light = document.getElementById('codiware-css-light');
  const dark = document.getElementById('codiware-css-dark');
  const toastuiDark = document.getElementById('codiware-css-toastui-dark');
  if (light) light.disabled = theme !== 'light';
  if (dark) dark.disabled = theme !== 'dark';
  if (toastuiDark) toastuiDark.disabled = theme !== 'dark';
}

function ensureBottomLayoutCompatibility(layout) {
  const STRIPE_HEIGHT = 32;

  const getMain = () => layout.root.querySelector('.ide-main');
  const getBottom = () => layout.slots.bottomPanel;
  const getSplitter = () => layout.slots.bottomSplitter || layout.root.querySelector('.ide-main > .ide-splitter');

  if (typeof layout.expandBottom !== 'function') {
    layout.expandBottom = (px = 220) => {
      const main = getMain();
      const bottom = getBottom();
      const splitter = getSplitter();
      const height = Math.max(STRIPE_HEIGHT + 40, px || 220);

      if (main) {
        main.classList.add('has-bottom');
        main.style.gridTemplateRows = `1fr 5px ${height}px`;
      }
      if (splitter) splitter.style.display = '';
      if (bottom) bottom.classList.remove('is-collapsed');

      layout.bottomHeight = height;
    };
  }
  if (typeof layout.collapseBottom !== 'function') {
    layout.collapseBottom = () => {
      const main = getMain();
      const bottom = getBottom();
      const splitter = getSplitter();

      if (main) {
        main.classList.remove('has-bottom');
        main.style.gridTemplateRows = `1fr ${STRIPE_HEIGHT}px`;
      }
      if (splitter) splitter.style.display = 'none';
      if (bottom) bottom.classList.add('is-collapsed');
    };
  }
  if (typeof layout.isBottomCollapsed !== 'function') {
    layout.isBottomCollapsed = () => getBottom()?.classList.contains('is-collapsed') === true;
  }
  if (typeof layout.toggleBottom !== 'function') {
    layout.toggleBottom = (defaultHeight = 220) => {
      if (layout.isBottomCollapsed()) layout.expandBottom(defaultHeight);
      else layout.collapseBottom();
    };
  }
}

function ensureBottomPanelSlots(layout) {
  if (layout.slots.bottomTabs && layout.slots.bottomContent) {
    return { tabsEl: layout.slots.bottomTabs, contentEl: layout.slots.bottomContent };
  }

  const bottom = layout.slots.bottomPanel;
  let tabsEl = bottom.querySelector(':scope > .ide-bottom-tabs');
  let contentEl = bottom.querySelector(':scope > .ide-bottom-content');

  if (!tabsEl) {
    tabsEl = document.createElement('div');
    tabsEl.className = 'ide-bottom-tabs';
    bottom.prepend(tabsEl);
  }
  if (!contentEl) {
    contentEl = document.createElement('div');
    contentEl.className = 'ide-bottom-content';
    bottom.append(contentEl);
  }

  layout.slots.bottomTabs = tabsEl;
  layout.slots.bottomContent = contentEl;
  return { tabsEl, contentEl };
}

function createGitFooterStatus({ api, i18n, repoName, onOpenPanel, onOpenBranchMenu }) {
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
  const branchBtn = document.createElement('button');
  branchBtn.type = 'button';
  branchBtn.className = 'ide-status-git-branch';
  const branchLabel = i18n.t('git.select_branch') || 'Select branch';
  branchBtn.title = branchLabel;
  branchBtn.setAttribute('aria-label', branchLabel);
  const branchNameEl = document.createElement('span');
  branchNameEl.className = 'ide-status-git-branch-name';
  branchNameEl.textContent = '—';
  branchBtn.append(branchNameEl, Icon.render('fa fa-caret-down'));

  const aheadBehindEl = document.createElement('span');
  aheadBehindEl.className = 'ide-status-git-ab';
  const countsEl = document.createElement('span');
  countsEl.className = 'ide-status-git-counts';

  mainBtn.append(repoEl, branchBtn, aheadBehindEl, countsEl);
  el.append(refreshBtn, mainBtn);

  refreshBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    refresh();
  });
  mainBtn.addEventListener('click', () => onOpenPanel?.());
  branchBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    onOpenBranchMenu?.(branchBtn);
  });

  function renderStatusTokens(container, entries) {
    container.replaceChildren();
    entries.forEach(([label, value], index) => {
      if (index > 0) {
        container.append(document.createTextNode(' '));
      }
      const token = document.createElement('span');
      token.className = 'ide-status-git-token';
      token.textContent = `${label}${value}`;
      token.classList.toggle('is-alert', Number(value) > 0);
      container.append(token);
    });
  }

  function updateFromStatus(status) {
    if (!status) return;
    const counts = summarizeGitStatus(status);
    const ahead = Number(status.ahead || 0);
    const behind = Number(status.behind || 0);
    const hasAheadBehind = ahead > 0 || behind > 0;
    const hasCounts = counts.changed > 0 || counts.deleted > 0 || counts.untracked > 0 || counts.staged > 0;

    branchNameEl.textContent = status.branch || '(detached)';
    renderStatusTokens(aheadBehindEl, [['+', ahead], ['-', behind]]);
    renderStatusTokens(countsEl, [['M', counts.changed], ['D', counts.deleted], ['?', counts.untracked], ['S', counts.staged]]);
    mainBtn.classList.toggle('is-alert', hasAheadBehind || hasCounts);
    const title = [
      `${repoName}`,
      `${i18n.t('git.branch')}: ${status.branch || '(detached)'}`,
      `Ahead: ${ahead}  Behind: ${behind}`,
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
