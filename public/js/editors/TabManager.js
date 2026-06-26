import { Icon } from '../core/Icon.js';

/**
 * Manages open editor tabs in the main area.
 *
 * Each tab tracks { path, entry, editor, descriptor }.
 * Only one editor is mounted in the host at a time; switching tabs swaps
 * the DOM. Editors keep their state in memory between switches.
 */
export class TabManager {
  constructor({ tabBar, host, api, registry, ctx, i18n, toasts, bus, settings }) {
    this.tabBar = tabBar;
    this.host = host;
    this.api = api;
    this.registry = registry;
    this.ctx = ctx;
    this.i18n = i18n;
    this.toasts = toasts;
    this.bus = bus;
    this.settings = settings || null;
    this.tabs = new Map();
    this.active = null;
    // While restoring previously opened tabs we suppress persistence so the
    // restore loop does not repeatedly rewrite the stored list.
    this._restoring = false;
  }

  /**
   * Persist the list of open file tabs and the active tab to the repo-scoped
   * settings store. Diff tabs are intentionally excluded – they are derived
   * from Git state and should not be reopened on the next session.
   */
  _persistOpenTabs() {
    if (!this.settings || this._restoring) return;
    const open = [];
    for (const record of this.tabs.values()) {
      if (record.isDiff) continue;
      open.push({ path: record.entry.path, name: record.entry.name });
    }
    const activeRecord = this.active ? this.tabs.get(this.active) : null;
    const active = activeRecord && !activeRecord.isDiff ? activeRecord.key : null;
    this.settings.setRepo('openTabs', { open, active });
  }

  /**
   * Reopen the file tabs persisted from a previous session. Files that no
   * longer exist are skipped. Diff tabs are never restored.
   */
  async restore() {
    if (!this.settings) return;
    const saved = this.settings.getRepo('openTabs', null);
    if (!saved || !Array.isArray(saved.open) || saved.open.length === 0) return;
    this._restoring = true;
    try {
      for (const item of saved.open) {
        if (!item || typeof item.path !== 'string') continue;
        await this.open({ path: item.path, name: item.name || item.path.split('/').pop() });
      }
    } finally {
      this._restoring = false;
    }
    if (saved.active && this.tabs.has(saved.active)) {
      this.activate(saved.active);
    }
    this._persistOpenTabs();
  }

  async open(entry) {
    const key = entry.path;
    if (this.tabs.has(key)) {
      this.activate(key);
      return;
    }
    const descriptor = this.registry.pick(entry);
    if (!descriptor) {
      this.toasts.error(this.i18n.t('editor.binary'));
      return;
    }

    // Build tab UI
    const tabEl = document.createElement('div');
    tabEl.className = 'ide-tab';
    tabEl.title = entry.path;
    const name = document.createElement('span');
    name.className = 'ide-tab-name';
    name.textContent = entry.name || entry.path.split('/').pop();

    // Per styleguide: small floppy icon appears when dirty; clicking it saves.
    const dirtyBtn = document.createElement('span');
    dirtyBtn.className = 'ide-tab-dirty';
    dirtyBtn.title = this.i18n.t('actions.save');
    dirtyBtn.append(Icon.render('fa fa-floppy-o'));
    dirtyBtn.style.display = 'none';
    dirtyBtn.addEventListener('click', (e) => { e.stopPropagation(); this.save(key); });

    const close = document.createElement('span');
    close.className = 'ide-tab-close';
    close.append(Icon.render('fa fa-times'));
    close.title = this.i18n.t('actions.close');
    close.addEventListener('click', (e) => { e.stopPropagation(); this.close(key); });

    tabEl.append(name, dirtyBtn, close);
    this._bindTabInteractions(tabEl, key);
    this.tabBar.appendChild(tabEl);

    // Build editor host (dedicated div per tab, hidden when not active)
    const editorHost = document.createElement('div');
    editorHost.style.height = '100%';
    editorHost.style.display = 'none';
    this.host.appendChild(editorHost);

    const editor = descriptor.create(editorHost, this.ctx);
    const record = { key, entry, tabEl, editorHost, editor, descriptor, dirty: false, dirtyBtn };

    if (typeof editor.on === 'function') {
      editor.on('change', () => {
        record.dirty = editor.isDirty();
        tabEl.classList.toggle('dirty', record.dirty);
        dirtyBtn.style.display = record.dirty ? '' : 'none';
      });
      editor.on('save-request', () => this.save(key));
    }

    this.tabs.set(key, record);

    // Load content for text-like editors via /files/read; image editor reads its own URL.
    try {
      if (descriptor.id !== 'codiware.image') {
        const data = await this.api.get('/files/read', { path: entry.path });
        if (data?.binary) {
          this.toasts.error(this.i18n.t('editor.binary'));
          this.close(key);
          return;
        }
        editor.load(data?.content ?? '', { path: entry.path });
      } else {
        editor.load(null, { path: entry.path });
      }
    } catch (e) {
      this.toasts.error(e.message);
      this.close(key);
      return;
    }

    this.activate(key);
  }

  activate(key) {
    const record = this.tabs.get(key);
    if (!record) return;
    for (const r of this.tabs.values()) {
      r.tabEl.classList.toggle('active', r.key === key);
      r.editorHost.style.display = r.key === key ? '' : 'none';
    }
    this.active = key;
    this.bus.emit('tab:activated', record);
    this._persistOpenTabs();
    // Move keyboard focus into the editor so shortcuts like Ctrl+S target the
    // active document instead of staying on the sidebar element that was
    // clicked last. The editor may still be initialising, so this is optional.
    record.editor.focus?.();
  }

  async save(key) {
    const record = this.tabs.get(key);
    if (!record) return;
    if (typeof record.editor.getContent !== 'function') return;
    const content = record.editor.getContent();
    if (content === null) return;
    try {
      await this.api.put('/files/write', { path: record.entry.path, content });
      record.editor.markClean?.();
      record.dirty = false;
      record.tabEl.classList.remove('dirty');
      if (record.dirtyBtn) record.dirtyBtn.style.display = 'none';
      this.toasts.success(this.i18n.t('actions.save') + ' \u2713');
      this.bus.emit('file:saved', record);
    } catch (e) {
      this.toasts.error(e.message);
    }
  }

  _bindTabInteractions(tabEl, key) {
    tabEl.addEventListener('click', () => this.activate(key));
    tabEl.addEventListener('mousedown', (e) => {
      // Prevent browser autoscroll indicator on middle click.
      if (e.button === 1) e.preventDefault();
    });
    tabEl.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      this.close(key);
    });
  }

  saveActive() { if (this.active) return this.save(this.active); }

  close(key) {
    const record = this.tabs.get(key);
    if (!record) return;
    if (record.dirty) {
      const message = this.i18n.t('editor.discard_changes_confirm', { path: record.entry.path });
      const ok = window.confirm(message);
      if (!ok) return;
    }
    try { record.editor.destroy?.(); } catch {}
    record.tabEl.remove();
    record.editorHost.remove();
    this.tabs.delete(key);
    if (this.active === key) {
      const next = this.tabs.keys().next();
      this.active = null;
      if (!next.done) this.activate(next.value);
    }
    this._persistOpenTabs();
  }

  /**
   * Force-close any open tab whose file path equals `path` or lies below it
   * (when `path` denotes a deleted directory). Skips the dirty-changes prompt
   * because the underlying file no longer exists on disk.
   */
  closePath(path) {
    if (!path && path !== '') return;
    const prefix = path === '' ? '' : path + '/';
    const toClose = [];
    for (const key of this.tabs.keys()) {
      if (key === path || key.startsWith(prefix)) toClose.push(key);
    }
    for (const key of toClose) {
      const record = this.tabs.get(key);
      if (!record) continue;
      try { record.editor.destroy?.(); } catch {}
      record.tabEl.remove();
      record.editorHost.remove();
      this.tabs.delete(key);
      if (this.active === key) this.active = null;
    }
    if (this.active === null && this.tabs.size > 0) {
      this.activate(this.tabs.keys().next().value);
    }
    this._persistOpenTabs();
  }

  /**
   * Open a diff view for a file. Used by the git panel to show changes.
   * @param {Object} options - { path: string, staged: boolean, diffData: { old: string, new: string }, key?: string, label?: string, readOnly?: boolean }
   */
  openDiff({ path, staged, diffData, key: customKey, label: customLabel, readOnly = false }) {
    // Use a unique key that distinguishes staged vs working-copy diffs
    const key = customKey || `diff:${staged ? 'staged' : 'working'}:${path}`;
    if (this.tabs.has(key)) {
      this.activate(key);
      return;
    }

    // Look up the diff editor descriptor by ID
    const descriptor = this.registry.entries.find(d => d.id === 'codiware.diff');
    if (!descriptor) {
      this.toasts.error('Diff editor not available');
      return;
    }

    // Build tab UI
    const tabEl = document.createElement('div');
    tabEl.className = 'ide-tab';
    const fileName = path.split('/').pop();
    const label = customLabel || (staged ? `${fileName} (Staged)` : `${fileName} (Working)`);
    tabEl.title = `Diff: ${path}`;
    const name = document.createElement('span');
    name.className = 'ide-tab-name';
    name.textContent = label;

    // Dirty indicator (floppy icon) for diff tabs
    const dirtyBtn = document.createElement('span');
    dirtyBtn.className = 'ide-tab-dirty';
    dirtyBtn.title = this.i18n.t('actions.save');
    dirtyBtn.append(Icon.render('fa fa-floppy-o'));
    dirtyBtn.style.display = 'none';
    dirtyBtn.addEventListener('click', (e) => { e.stopPropagation(); this.save(key); });

    const close = document.createElement('span');
    close.className = 'ide-tab-close';
    close.append(Icon.render('fa fa-times'));
    close.title = this.i18n.t('actions.close');
    close.addEventListener('click', (e) => { e.stopPropagation(); this.close(key); });

    tabEl.append(name, dirtyBtn, close);
    this._bindTabInteractions(tabEl, key);
    this.tabBar.appendChild(tabEl);

    // Build editor host
    const editorHost = document.createElement('div');
    editorHost.style.height = '100%';
    editorHost.style.display = 'none';
    this.host.appendChild(editorHost);

    const editor = descriptor.create(editorHost, this.ctx);
    const record = { key, entry: { path }, tabEl, editorHost, editor, descriptor, dirty: false, isDiff: true, dirtyBtn };

    // Listen for changes and save requests
    if (typeof editor.on === 'function') {
      editor.on('change', () => {
        record.dirty = editor.isDirty();
        tabEl.classList.toggle('dirty', record.dirty);
        dirtyBtn.style.display = record.dirty ? '' : 'none';
      });
      editor.on('save-request', () => this.save(key));
    }

    this.tabs.set(key, record);

    // Load the diff data
    editor.load({
      original: diffData.old || '',
      modified: diffData.new || '',
      path: path,
      staged: staged,
      readOnly: readOnly,
    });

    this.activate(key);
  }
}
