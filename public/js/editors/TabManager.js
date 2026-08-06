import { Icon } from '../core/Icon.js';

/**
 * Manages open editor tabs in the main area.
 *
 * Each tab tracks { path, entry, editor, descriptor }. Only one editor is
 * mounted in the host at a time; switching tabs swaps the DOM. Editors keep
 * their state in memory between switches. Tabs can also be pinned: pinned
 * tabs stay grouped at the start of the tab bar, persist per repository and
 * are excluded from the dedicated "close unpinned tabs" bulk action.
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
    this._draggedTabKey = null;
    this._tabContextMenuEl = null;
    this._tabContextMenuCleanup = null;
  }

  /**
   * Persist the current tab order, pinned state and active tab per repository.
   *
   * Diff tabs are intentionally excluded from restoration because they are
   * derived from Git state. Pinned state is stored alongside every regular
   * file tab so a restored session recreates the same left-aligned pinned tab
   * group before any unpinned tabs.
   */
  _persistOpenTabs() {
    if (!this.settings || this._restoring) return;
    const open = [];
    for (const record of this.tabs.values()) {
      if (record.isDiff) continue;
      open.push({ path: record.entry.path, name: record.entry.name, pinned: !!record.pinned });
    }
    const activeRecord = this.active ? this.tabs.get(this.active) : null;
    const active = activeRecord && !activeRecord.isDiff ? activeRecord.key : null;
    this.settings.setRepo('openTabs', { open, active });
  }

  /**
   * Reopen the file tabs persisted from a previous session.
   *
   * Files that no longer exist are skipped. Diff tabs are never restored.
   * Pinned tabs are restored together with their saved order so the tab bar
   * immediately re-creates the same pinned/unpinned grouping from the last
   * browser session.
   */
  async restore() {
    if (!this.settings) return;
    const saved = this.settings.getRepo('openTabs', null);
    if (!saved || !Array.isArray(saved.open) || saved.open.length === 0) return;
    this._restoring = true;
    try {
      for (const item of saved.open) {
        if (!item || typeof item.path !== 'string') continue;
        await this.open({ path: item.path, name: item.name || item.path.split('/').pop() }, { pinned: !!item.pinned });
      }
    } finally {
      this._restoring = false;
    }
    if (saved.active && this.tabs.has(saved.active)) {
      this.activate(saved.active);
    }
    this._persistOpenTabs();
  }

  async open(entry, options = {}) {
    const descriptor = this._resolveDescriptor(entry, options);
    if (!descriptor) {
      this.toasts.error(this.i18n.t('editor.binary'));
      return;
    }

    const key = options.key || entry.path;
    if (this.tabs.has(key)) {
      if (options.pinned) this.setPinned(key, true);
      this.activate(key);
      return;
    }

    // Build tab UI
    const tabEl = document.createElement('div');
    tabEl.className = 'ide-tab';
    tabEl.title = entry.path;
    tabEl.draggable = true;
    const name = document.createElement('span');
    name.className = 'ide-tab-name';
    name.textContent = options.label || entry.name || entry.path.split('/').pop();

    const pinBtn = this._createPinButton(key, { disabled: false });

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

    tabEl.append(name, pinBtn, dirtyBtn, close);
    this._bindTabInteractions(tabEl, key);

    // Build editor host (dedicated div per tab, hidden when not active)
    const editorHost = document.createElement('div');
    editorHost.style.height = '100%';
    editorHost.style.display = 'none';
    this.host.appendChild(editorHost);

    const editor = descriptor.create(editorHost, this.ctx);
    const record = { key, entry, tabEl, editorHost, editor, descriptor, dirty: false, dirtyBtn, pinBtn, pinned: false };

    if (typeof editor.on === 'function') {
      editor.on('change', () => {
        record.dirty = editor.isDirty();
        tabEl.classList.toggle('dirty', record.dirty);
        dirtyBtn.style.display = record.dirty ? '' : 'none';
      });
      editor.on('save-request', () => this.save(key));
    }

    this.tabs.set(key, record);
    this._insertTabByPinnedState(record, { mode: 'append-group' });
    this._renderPinnedState(record);

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

    if (options.pinned) this.setPinned(key, true, { focus: false });
    this.activate(key);
  }

  /**
   * Create the inline pin control for one tab.
   *
   * Regular file tabs receive an interactive button that toggles pinned state.
   * Diff tabs call the same helper with `disabled: true`, which returns a
   * hidden placeholder so the tab keeps its internal structure without showing
   * a control that intentionally does nothing.
   */
  _createPinButton(key, { disabled = false } = {}) {
    const pinBtn = document.createElement('span');
    pinBtn.className = 'ide-tab-pin';
    if (disabled) {
      pinBtn.hidden = true;
      pinBtn.setAttribute('aria-hidden', 'true');
      return pinBtn;
    }
    pinBtn.title = this.i18n.t('tabs.pin');
    pinBtn.setAttribute('role', 'button');
    pinBtn.setAttribute('tabindex', '0');
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePinned(key);
    });
    pinBtn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      this.togglePinned(key);
    });
    return pinBtn;
  }

  _resolveDescriptor(entry, options = {}) {
    if (options.editorId) {
      return this.registry.getById(options.editorId);
    }
    return this.registry.pick(entry);
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
    // Editors that persist binary or otherwise custom-encoded content expose a
    // getSavePayload() returning { content, encoding }; text editors use the
    // plain getContent() string path below.
    if (typeof record.editor.getSavePayload === 'function') {
      try {
        const payload = record.editor.getSavePayload();
        if (!payload || payload.content == null) return;
        await this.api.put('/files/write', {
          path: record.entry.path,
          content: payload.content,
          encoding: payload.encoding || 'utf8',
        });
        record.editor.markClean?.();
        record.dirty = false;
        record.tabEl.classList.remove('dirty');
        if (record.dirtyBtn) record.dirtyBtn.style.display = 'none';
        this.toasts.success(this.i18n.t('actions.save') + ' ✓');
        this.bus.emit('file:saved', record);
      } catch (e) {
        this.toasts.error(e.message);
      }
      return;
    }
    if (typeof record.editor.getContent !== 'function') return;
    try {
      // Allow editors to run async pre-save processing (e.g. the markdown
      // editor externalizes any leftover inline base64 images into files).
      if (typeof record.editor.beforeSave === 'function') {
        await record.editor.beforeSave();
      }
      const content = record.editor.getContent();
      if (content === null) return;
      await this.api.put('/files/write', { path: record.entry.path, content });
      record.editor.markClean?.();
      record.dirty = false;
      record.tabEl.classList.remove('dirty');
      if (record.dirtyBtn) record.dirtyBtn.style.display = 'none';
      this.toasts.success(this.i18n.t('actions.save') + ' ✓');
      this.bus.emit('file:saved', record);
    } catch (e) {
      this.toasts.error(e.message);
    }
  }

  _bindTabInteractions(tabEl, key) {
    tabEl.addEventListener('click', () => this.activate(key));
    tabEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.activate(key);
      this._openTabContextMenu(key, e.clientX, e.clientY);
    });
    tabEl.addEventListener('mousedown', (e) => {
      // Prevent browser autoscroll indicator on middle click.
      if (e.button === 1) e.preventDefault();
    });
    tabEl.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      this.close(key);
    });
    tabEl.addEventListener('dragstart', (e) => {
      this._closeTabContextMenu();
      this._draggedTabKey = key;
      tabEl.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', key);
      }
    });
    tabEl.addEventListener('dragend', () => {
      tabEl.classList.remove('is-dragging');
      this._draggedTabKey = null;
      this._clearTabDropMarkers();
    });
    tabEl.addEventListener('dragover', (e) => {
      if (!this._draggedTabKey || this._draggedTabKey === key) return;
      e.preventDefault();
      const position = this._getDropPosition(tabEl, e.clientX);
      this._markTabDropTarget(tabEl, position);
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });
    tabEl.addEventListener('dragleave', (e) => {
      if (!tabEl.contains(e.relatedTarget)) this._clearTabDropMarkers();
    });
    tabEl.addEventListener('drop', (e) => {
      if (!this._draggedTabKey || this._draggedTabKey === key) return;
      e.preventDefault();
      const position = this._getDropPosition(tabEl, e.clientX);
      this._moveTab(this._draggedTabKey, key, position);
      this._clearTabDropMarkers();
    });
  }

  _getDropPosition(tabEl, clientX) {
    const rect = tabEl.getBoundingClientRect();
    return clientX < rect.left + rect.width / 2 ? 'before' : 'after';
  }

  _markTabDropTarget(tabEl, position) {
    this._clearTabDropMarkers();
    tabEl.classList.add(position === 'before' ? 'drop-before' : 'drop-after');
  }

  _clearTabDropMarkers() {
    for (const record of this.tabs.values()) {
      record.tabEl.classList.remove('drop-before', 'drop-after');
    }
  }

  /**
   * Rebuild the tab map from the current DOM order.
   *
   * The DOM is the source of truth for visual tab order after drag/drop or
   * pinning moves. Rebuilding the map keeps persistence, left/right bulk close
   * operations and active-tab fallback aligned with what the user actually
   * sees in the tab bar.
   */
  _syncTabOrderFromDom() {
    const reordered = new Map();
    for (const node of this.tabBar.children) {
      const entry = Array.from(this.tabs.entries()).find(([, record]) => record.tabEl === node);
      if (!entry) continue;
      reordered.set(entry[0], entry[1]);
    }
    this.tabs = reordered;
  }

  /**
   * Insert one tab element into the DOM so pinned tabs stay grouped first.
   *
   * Supported modes:
   * - `append-group`: append to the end of the current group.
   * - `prepend-unpinned`: place directly behind the pinned block.
   *
   * This lets pin/unpin operations express their intended UX explicitly
   * instead of relying on one generic insertion rule for both directions.
   */
  _insertTabByPinnedState(record, { mode = 'append-group' } = {}) {
    if (!record?.tabEl) return;
    const siblings = Array.from(this.tabBar.children).filter((node) => node !== record.tabEl);
    let referenceNode = null;

    if (mode === 'prepend-unpinned' && !record.pinned) {
      referenceNode = siblings.find((node) => !(this._recordFromTabElement(node)?.pinned)) || null;
    } else if (record.pinned) {
      referenceNode = siblings.find((node) => !(this._recordFromTabElement(node)?.pinned)) || null;
    } else {
      referenceNode = null;
    }

    if (referenceNode) {
      this.tabBar.insertBefore(record.tabEl, referenceNode);
    } else {
      this.tabBar.appendChild(record.tabEl);
    }
    this._syncTabOrderFromDom();
  }

  /**
   * Resolve the tab record that owns one rendered tab element.
   */
  _recordFromTabElement(tabEl) {
    for (const record of this.tabs.values()) {
      if (record.tabEl === tabEl) return record;
    }
    return null;
  }

  /**
   * Update the tab DOM so pinned state is visible via CSS classes, labels and
   * the pin icon variant.
   */
  _renderPinnedState(record) {
    if (!record?.tabEl || !record?.pinBtn || record.pinBtn.hidden) return;
    const pinned = !!record.pinned;
    record.tabEl.classList.toggle('is-pinned', pinned);
    record.pinBtn.classList.toggle('is-active', pinned);
    record.pinBtn.title = this.i18n.t(pinned ? 'tabs.unpin' : 'tabs.pin');
    record.pinBtn.setAttribute('aria-label', record.pinBtn.title);
    record.pinBtn.innerHTML = '';
    record.pinBtn.append(Icon.render(pinned ? 'fa fa-thumb-tack' : 'fa fa-thumb-tack'));
  }

  /**
   * Toggle one tab between pinned and unpinned state.
   */
  togglePinned(key) {
    const record = this.tabs.get(key);
    if (!record) return;
    this.setPinned(key, !record.pinned);
  }

  /**
   * Apply pinned state to one tab, move it into the correct group and persist
   * the resulting order.
   *
   * Pinning appends the tab to the pinned block. Unpinning places it at the
   * front of the unpinned block so it stays directly after the pinned tabs
   * instead of jumping to the far end of the tab bar.
   */
  setPinned(key, pinned, { focus = false } = {}) {
    const record = this.tabs.get(key);
    if (!record || record.isDiff) return;
    const nextPinned = !!pinned;
    if (!!record.pinned === nextPinned) {
      if (focus) this.activate(key);
      return;
    }
    record.pinned = nextPinned;
    this._renderPinnedState(record);
    this._insertTabByPinnedState(record, { mode: nextPinned ? 'append-group' : 'prepend-unpinned' });
    if (focus) this.activate(key);
    this._persistOpenTabs();
  }

  _moveTab(sourceKey, targetKey, position) {
    const source = this.tabs.get(sourceKey);
    const target = this.tabs.get(targetKey);
    if (!source || !target || sourceKey === targetKey) return;
    if (!!source.pinned !== !!target.pinned) return;

    const targetEl = target.tabEl;
    if (position === 'before') {
      this.tabBar.insertBefore(source.tabEl, targetEl);
    } else {
      this.tabBar.insertBefore(source.tabEl, targetEl.nextSibling);
    }

    this._syncTabOrderFromDom();
    this._persistOpenTabs();
  }

  _openTabContextMenu(key, clientX, clientY) {
    const record = this.tabs.get(key);
    if (!record) return;
    this._closeTabContextMenu();

    const orderedKeys = Array.from(this.tabs.keys());
    const index = orderedKeys.indexOf(key);
    if (index === -1) return;

    const unpinnedKeys = orderedKeys.filter((tabKey) => !this.tabs.get(tabKey)?.pinned);
    const counts = {
      left: index,
      right: orderedKeys.length - index - 1,
      others: orderedKeys.length - 1,
      all: orderedKeys.length,
      unpinned: unpinnedKeys.length,
    };

    const menu = document.createElement('div');
    menu.className = 'codiware-popup-menu codiware-tab-context-menu';
    menu.setAttribute('role', 'menu');

    const addItem = ({ label, icon, onClick, disabled = false }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menu-item';
      btn.setAttribute('role', 'menuitem');
      if (disabled) btn.disabled = true;
      btn.append(Icon.render(icon));
      const text = document.createElement('span');
      text.textContent = label;
      btn.append(text);
      btn.addEventListener('click', () => {
        if (disabled) return;
        this._closeTabContextMenu();
        onClick();
      });
      menu.append(btn);
    };

    addItem({
      label: this.i18n.t(record.pinned ? 'tabs.unpin' : 'tabs.pin'),
      icon: 'fa fa-thumb-tack',
      onClick: () => this.togglePinned(key),
      disabled: record.isDiff,
    });

    const separator = document.createElement('div');
    separator.className = 'menu-sep';
    menu.append(separator);

    addItem({
      label: this.i18n.t('tabs.close_unpinned'),
      icon: 'fa fa-times',
      onClick: () => this.closeUnpinnedTabs(),
      disabled: counts.unpinned === 0,
    });
    addItem({
      label: this.i18n.t('tabs.close_all'),
      icon: 'fa fa-times-circle',
      onClick: () => this.closeAllTabs(),
      disabled: counts.all === 0,
    });
    addItem({
      label: this.i18n.t('tabs.close_left'),
      icon: 'fa fa-angle-double-left',
      onClick: () => this.closeTabsToLeft(key),
      disabled: counts.left === 0,
    });
    addItem({
      label: this.i18n.t('tabs.close_right'),
      icon: 'fa fa-angle-double-right',
      onClick: () => this.closeTabsToRight(key),
      disabled: counts.right === 0,
    });
    addItem({
      label: this.i18n.t('tabs.close_others'),
      icon: 'fa fa-window-close-o',
      onClick: () => this.closeOtherTabs(key),
      disabled: counts.others === 0,
    });

    document.body.appendChild(menu);
    const { innerWidth, innerHeight } = window;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(4, Math.min(clientX, innerWidth - rect.width - 4));
    const top = Math.max(4, Math.min(clientY, innerHeight - rect.height - 4));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const closeOnPointer = (event) => {
      if (menu.contains(event.target)) return;
      this._closeTabContextMenu();
    };
    const closeOnKey = (event) => {
      if (event.key === 'Escape') this._closeTabContextMenu();
    };

    document.addEventListener('mousedown', closeOnPointer, true);
    document.addEventListener('contextmenu', closeOnPointer, true);
    document.addEventListener('keydown', closeOnKey, true);

    this._tabContextMenuEl = menu;
    this._tabContextMenuCleanup = () => {
      document.removeEventListener('mousedown', closeOnPointer, true);
      document.removeEventListener('contextmenu', closeOnPointer, true);
      document.removeEventListener('keydown', closeOnKey, true);
    };
  }

  _closeTabContextMenu() {
    if (typeof this._tabContextMenuCleanup === 'function') {
      try { this._tabContextMenuCleanup(); } catch {}
    }
    this._tabContextMenuCleanup = null;
    if (this._tabContextMenuEl) {
      this._tabContextMenuEl.remove();
      this._tabContextMenuEl = null;
    }
  }

  _orderedTabKeys() {
    return Array.from(this.tabs.keys());
  }

  closeTabs(keys, { keepActiveFallback = true } = {}) {
    const unique = Array.from(new Set((keys || []).filter((key) => this.tabs.has(key))));
    if (unique.length === 0) return;

    const activeWasClosed = unique.includes(this.active);
    for (const key of unique) {
      this._closeRecord(key, { skipPrompt: false, persist: false, activateFallback: false });
    }

    if (keepActiveFallback && activeWasClosed && this.tabs.size > 0) {
      this.activate(this.tabs.keys().next().value);
    } else {
      this._persistOpenTabs();
    }
  }

  closeAllTabs() {
    this.closeTabs(this._orderedTabKeys());
  }

  /**
   * Close only tabs that are currently not pinned.
   */
  closeUnpinnedTabs() {
    this.closeTabs(this._orderedTabKeys().filter((key) => !this.tabs.get(key)?.pinned));
  }

  closeTabsToLeft(key) {
    const ordered = this._orderedTabKeys();
    const index = ordered.indexOf(key);
    if (index <= 0) return;
    this.closeTabs(ordered.slice(0, index));
  }

  closeTabsToRight(key) {
    const ordered = this._orderedTabKeys();
    const index = ordered.indexOf(key);
    if (index === -1 || index >= ordered.length - 1) return;
    this.closeTabs(ordered.slice(index + 1));
  }

  closeOtherTabs(key) {
    const ordered = this._orderedTabKeys();
    if (!this.tabs.has(key)) return;
    this.closeTabs(ordered.filter((tabKey) => tabKey !== key));
  }

  saveActive() { if (this.active) return this.save(this.active); }

  _closeRecord(key, { skipPrompt = false, persist = true, activateFallback = true } = {}) {
    const record = this.tabs.get(key);
    if (!record) return false;
    if (!skipPrompt && record.dirty) {
      const message = this.i18n.t('editor.discard_changes_confirm', { path: record.entry.path });
      const ok = window.confirm(message);
      if (!ok) return false;
    }
    this._closeTabContextMenu();
    try { record.editor.destroy?.(); } catch {}
    record.tabEl.remove();
    record.editorHost.remove();
    this.tabs.delete(key);
    if (this.active === key) {
      this.active = null;
      if (activateFallback && this.tabs.size > 0) {
        this.activate(this.tabs.keys().next().value);
        return true;
      }
    }
    if (persist) this._persistOpenTabs();
    return true;
  }

  close(key) {
    this._closeRecord(key);
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
      this._closeRecord(key, { skipPrompt: true, persist: false, activateFallback: false });
    }
    if (this.active === null && this.tabs.size > 0) {
      this.activate(this.tabs.keys().next().value);
    } else {
      this._persistOpenTabs();
    }
  }

  /**
   * Close all open diff tabs for the given repository path. This is used when
   * Git operations remove the underlying change, e.g. after discarding a file.
   */
  closeDiffsForPath(path) {
    if (!path && path !== '') return;
    const toClose = [];
    for (const [key, record] of this.tabs.entries()) {
      if (!record?.isDiff) continue;
      if (record.entry?.path === path) toClose.push(key);
    }
    for (const key of toClose) {
      this._closeRecord(key, { skipPrompt: true, persist: false, activateFallback: false });
    }
    if (this.active === null && this.tabs.size > 0) {
      this.activate(this.tabs.keys().next().value);
    } else {
      this._persistOpenTabs();
    }
  }

  /**
   * Open a diff view for a file. Used by the git panel to show changes.
   * @param {Object} options - { path: string, staged: boolean, diffData: { old: string, new: string, type?: string }, key?: string, label?: string, readOnly?: boolean }
   */
  openDiff({ path, staged, diffData, key: customKey, label: customLabel, readOnly = false }) {
    // Use a unique key that distinguishes staged vs working-copy diffs.
    const key = customKey || `diff:${staged ? 'staged' : 'working'}:${path}`;
    if (this.tabs.has(key)) {
      this.activate(key);
      return;
    }

    const isImageDiff = diffData?.type === 'image';
    const descriptorId = isImageDiff ? 'codiware.diffImage' : 'codiware.diff';
    const descriptor = this.registry.getById(descriptorId);
    if (!descriptor) {
      this.toasts.error(isImageDiff ? 'Image diff editor not available' : 'Diff editor not available');
      return;
    }

    // Build tab UI
    const tabEl = document.createElement('div');
    tabEl.className = 'ide-tab';
    tabEl.draggable = true;
    const fileName = path.split('/').pop();
    const label = customLabel || (staged ? `${fileName} (Staged)` : `${fileName} (Working)`);
    tabEl.title = `Diff: ${path}`;
    const name = document.createElement('span');
    name.className = 'ide-tab-name';
    name.textContent = label;

    const pinBtn = this._createPinButton(key, { disabled: true });

    // Dirty indicator (floppy icon) for editable text diff tabs. Image diffs
    // are read-only and never emit changes, so the icon stays hidden there.
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

    tabEl.append(name, pinBtn, dirtyBtn, close);
    this._bindTabInteractions(tabEl, key);

    // Build editor host
    const editorHost = document.createElement('div');
    editorHost.style.height = '100%';
    editorHost.style.display = 'none';
    this.host.appendChild(editorHost);

    const editor = descriptor.create(editorHost, this.ctx);
    const record = { key, entry: { path }, tabEl, editorHost, editor, descriptor, dirty: false, isDiff: true, dirtyBtn, pinBtn, pinned: false };

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
    this.tabBar.appendChild(tabEl);
    this._syncTabOrderFromDom();

    // Load the diff data. Image diff payloads are already JSON-safe data URLs;
    // text diff payloads keep the Monaco `original`/`modified` contract.
    if (isImageDiff) {
      editor.load({ ...diffData, path, staged, readOnly });
    } else {
      editor.load({
        original: diffData.old || '',
        modified: diffData.new || '',
        path: path,
        staged: staged,
        readOnly: readOnly,
      });
    }

    this.activate(key);
  }
}
