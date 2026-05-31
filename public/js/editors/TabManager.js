import { Icon } from '../core/Icon.js';

/**
 * Manages open editor tabs in the main area.
 *
 * Each tab tracks { path, entry, editor, descriptor }.
 * Only one editor is mounted in the host at a time; switching tabs swaps
 * the DOM. Editors keep their state in memory between switches.
 */
export class TabManager {
  constructor({ tabBar, host, api, registry, ctx, i18n, toasts, bus }) {
    this.tabBar = tabBar;
    this.host = host;
    this.api = api;
    this.registry = registry;
    this.ctx = ctx;
    this.i18n = i18n;
    this.toasts = toasts;
    this.bus = bus;
    this.tabs = new Map();
    this.active = null;
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
    tabEl.addEventListener('click', () => this.activate(key));
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

  saveActive() { if (this.active) return this.save(this.active); }

  close(key) {
    const record = this.tabs.get(key);
    if (!record) return;
    if (record.dirty) {
      const ok = window.confirm(this.i18n.t('editor.unsaved') + ' — ' + record.entry.path);
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
  }
}
