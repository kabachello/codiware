import { Icon } from '../core/Icon.js';

/**
 * Default icon mapping used when no `fileIcons` config is passed in. The
 * config from PHP (`boot.file_icons`) is merged on top of this so missing
 * keys fall back to sensible defaults.
 */
const DEFAULT_FILE_ICONS = {
  default: 'fa fa-file-o',
  folder: 'fa fa-folder',
  folder_open: 'fa fa-folder-open',
  by_name: {},
  by_ext: {},
};

/**
 * Escape a string for safe use inside a CSS attribute selector. Falls back
 * to a manual backslash-escape when `CSS.escape` is not available.
 */
function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

/**
 * Recursive file tree using nested <ul> elements.
 *
 * Each directory is loaded lazily through `api.get('/files/tree', {path})`.
 * Renders a panel toolbar (new file/folder, refresh) above the tree and an
 * inline three-dot menu on each row for per-item actions (rename, delete,
 * duplicate, download, upload to folder, etc.).
 */
export class FileTree {
  constructor({ host, api, i18n, toasts, bus, onOpen, fileIcons, settings }) {
    this.host = host;
    this.api = api;
    this.i18n = i18n;
    this.toasts = toasts || { error: (m) => console.error(m), success: () => {} };
    this.bus = bus;
    this.onOpen = onOpen;
    this.settings = settings || null;
    this.fileIcons = {
      ...DEFAULT_FILE_ICONS,
      ...(fileIcons || {}),
      by_name: { ...DEFAULT_FILE_ICONS.by_name, ...((fileIcons && fileIcons.by_name) || {}) },
      by_ext: { ...DEFAULT_FILE_ICONS.by_ext, ...((fileIcons && fileIcons.by_ext) || {}) },
    };

    // Paths of folders the user has expanded. Preserved across refreshes so
    // file operations (create/rename/delete/upload) do not collapse the tree,
    // and persisted in the repo-scoped settings store so they are restored
    // when the workspace is reopened in a new browser session.
    this.expanded = new Set(this._loadExpanded());
    this.dragContext = null;
    this.activeDropRow = null;

    this.host.innerHTML = '';
    this.host.classList.add('file-tree-host');

    this.toolbarEl = document.createElement('div');
    this.toolbarEl.className = 'panel-toolbar';
    this._buildToolbar();
    this.host.appendChild(this.toolbarEl);

    this.rootUl = document.createElement('ul');
    this.rootUl.className = 'tree';
    this.host.appendChild(this.rootUl);

    this._setupRootDropTarget();
  }

  /** Read the persisted set of expanded folder paths from the repo settings. */
  _loadExpanded() {
    if (!this.settings) return [];
    const stored = this.settings.getRepo('tree.expanded', []);
    return Array.isArray(stored) ? stored.filter((p) => typeof p === 'string') : [];
  }

  /** Persist the current set of expanded folder paths to the repo settings. */
  _persistExpanded() {
    if (!this.settings) return;
    this.settings.setRepo('tree.expanded', Array.from(this.expanded));
  }

  _buildToolbar() {
    this.toolbarEl.append(
      this._tbBtn('fa fa-file-o', this.i18n.t('files.new_file'), () => this._createPrompt('', 'file')),
      this._tbBtn('fa fa-folder', this.i18n.t('files.new_folder'), () => this._createPrompt('', 'dir')),
      this._tbBtn('fa fa-upload', this.i18n.t('files.upload'), () => this._uploadInto('')),
      this._tbBtn('fa fa-file-archive-o', this.i18n.t('files.download_zip'), () => this._downloadPath('', 'workspace')),
      this._tbBtn('fa fa-refresh', this.i18n.t('actions.refresh'), () => this.refresh()),
    );
  }

  _tbBtn(icon, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tb-btn';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.append(Icon.render(icon));
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  async refresh() {
    this.rootUl.innerHTML = '';
    await this._renderInto(this.rootUl, '');
    await this._restoreExpansion();
  }

  /**
   * After a fresh root render, walk the remembered expanded set in
   * shortest-path order and re-open every folder that still exists. Paths
   * that no longer exist (e.g. deleted parent) are dropped from the set.
   */
  async _restoreExpansion() {
    if (this.expanded.size === 0) return;
    const paths = Array.from(this.expanded).sort((a, b) => a.split('/').length - b.split('/').length);
    let changed = false;
    for (const path of paths) {
      const li = this.rootUl.querySelector(`li[data-path="${cssEscape(path)}"]`);
      if (!li || !li.classList.contains('dir') || typeof li._open !== 'function') {
        this.expanded.delete(path);
        changed = true;
        continue;
      }
      if (!li.classList.contains('open')) {
        await li._open();
      }
    }
    if (changed) this._persistExpanded();
  }

  async _renderInto(ul, path) {
    let data;
    try { data = await this.api.get('/files/tree', { path }); }
    catch (e) {
      const li = document.createElement('li');
      li.textContent = e.message;
      li.style.color = '#c0392b';
      ul.appendChild(li);
      return;
    }
    const entries = data?.entries || [];
    if (entries.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = this.i18n.t('files.empty');
      li.style.opacity = '0.6';
      ul.appendChild(li);
      return;
    }
    for (const entry of entries) {
      ul.appendChild(this._renderEntry(entry));
    }
  }

  _renderEntry(entry) {
    const li = document.createElement('li');
    li.className = entry.type === 'dir' ? 'dir' : 'file';
    li.dataset.path = entry.path;

    const row = document.createElement('span');
    row.className = 'row';

    if (entry.type === 'dir') {
      const toggle = Icon.render('fa fa-caret-right', { extraClass: 'ide-icon-toggle' });
      const folderIconSpec = this.fileIcons.folder || 'fa fa-folder';
      const folderOpenSpec = this.fileIcons.folder_open || folderIconSpec;
      let folder = Icon.render(folderIconSpec);
      const name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = entry.name;
      row.append(toggle, folder, name);

      // Toggle helper bound to this <li>; reused by user clicks and by
      // `_restoreExpansion()` after a refresh.
      const setOpen = async (open) => {
        const isOpen = li.classList.contains('open');
        if (isOpen === open) return;
        li.classList.toggle('open', open);
        toggle.firstElementChild?.classList.toggle('fa-caret-right', !open);
        toggle.firstElementChild?.classList.toggle('fa-caret-down', open);
        const replacement = Icon.render(open ? folderOpenSpec : folderIconSpec);
        folder.replaceWith(replacement);
        folder = replacement;
        let childUl = li.querySelector(':scope > ul');
        if (open) {
          if (!childUl) {
            childUl = document.createElement('ul');
            li.appendChild(childUl);
            await this._renderInto(childUl, entry.path);
          }
          this.expanded.add(entry.path);
        } else {
          if (childUl) childUl.remove();
          this.expanded.delete(entry.path);
        }
        this._persistExpanded();
      };
      li._open = () => setOpen(true);
      li._close = () => setOpen(false);

      row.addEventListener('click', async (e) => {
        if (e.target.closest('.row-actions')) return;
        await setOpen(!li.classList.contains('open'));
      });

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._selectRow(row);
        this._openMenuAt(e.clientX, e.clientY, entry);
      });

      this._setupDropTarget(li, row, entry);
    } else {
      const file = Icon.render(this._iconForFile(entry.name));
      const name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = entry.name;
      row.append(document.createElement('span'), file, name); // empty span to align with toggle column
      row.firstElementChild.className = 'ide-icon ide-icon-toggle';
      row.addEventListener('click', (e) => {
        if (e.target.closest('.row-actions')) return;
        this._selectRow(row);
        this.onOpen?.(entry);
      });

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._selectRow(row);
        this._openMenuAt(e.clientX, e.clientY, entry);
      });
    }

    this._setupDragSource(row, entry);

    row.appendChild(this._renderRowActions(entry));
    li.appendChild(row);
    return li;
  }

  _setupDragSource(row, entry) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      if (e.target.closest('.row-actions')) {
        e.preventDefault();
        return;
      }
      this.dragContext = {
        entry,
        copy: !!(e.ctrlKey || e.metaKey),
      };
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', entry.path);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      this.dragContext = null;
      this._clearDropHighlight();
      this.host.classList.remove('tree-root-drop');
    });
  }

  _setupDropTarget(li, row, entry) {
    row.addEventListener('dragover', (e) => {
      const mode = this._dropModeFor(entry.path);
      if (mode === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = mode;
      this._setDropHighlight(row);
    });
    row.addEventListener('dragleave', (e) => {
      if (!row.contains(e.relatedTarget)) {
        this._clearDropHighlight(row);
      }
    });
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      this._clearDropHighlight(row);
      await this._performDrop(entry.path, e);
      // Keep folders open while moving items around inside them.
      if (li.classList.contains('dir')) {
        this.expanded.add(entry.path);
        this._persistExpanded();
      }
    });
  }

  _setupRootDropTarget() {
    this.host.addEventListener('dragover', (e) => {
      if (!this.dragContext) return;
      const mode = this._dropModeFor('');
      if (mode === null) return;
      // Avoid showing root-target hint while directly over folder rows.
      if (e.target.closest('.tree .row')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = mode;
      this.host.classList.add('tree-root-drop');
    });
    this.host.addEventListener('dragleave', (e) => {
      if (!this.host.contains(e.relatedTarget)) {
        this.host.classList.remove('tree-root-drop');
      }
    });
    this.host.addEventListener('drop', async (e) => {
      if (!this.dragContext) return;
      if (e.target.closest('.tree .row')) return;
      e.preventDefault();
      this.host.classList.remove('tree-root-drop');
      await this._performDrop('', e);
    });
  }

  _setDropHighlight(row) {
    if (this.activeDropRow === row) return;
    this._clearDropHighlight();
    this.activeDropRow = row;
    row.classList.add('drop-target');
  }

  _clearDropHighlight(row) {
    if (row) {
      row.classList.remove('drop-target');
      if (this.activeDropRow === row) this.activeDropRow = null;
      return;
    }
    if (this.activeDropRow) {
      this.activeDropRow.classList.remove('drop-target');
      this.activeDropRow = null;
    }
  }

  _dropModeFor(targetDir) {
    const drag = this.dragContext;
    if (!drag) return null;
    const source = drag.entry;
    if (!this._canDropInto(source, targetDir)) return null;
    return drag.copy ? 'copy' : 'move';
  }

  _canDropInto(source, targetDir) {
    const from = source.path;
    const fromParent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
    if (targetDir === fromParent) return false;
    if (targetDir === from) return false;
    if (source.type === 'dir' && targetDir.startsWith(from + '/')) return false;
    return true;
  }

  async _performDrop(targetDir, evt) {
    const drag = this.dragContext;
    if (!drag) return;
    const source = drag.entry;
    const name = source.path.split('/').pop();
    const to = targetDir === '' ? name : `${targetDir}/${name}`;
    if (to === source.path) return;

    const copy = !!(evt.ctrlKey || evt.metaKey || drag.copy);
    const endpoint = copy ? '/files/copy' : '/files/move';
    const action = copy ? 'copy' : 'move';

    try {
      await this.api.post(endpoint, { from: source.path, to });
      // Let the central files:changed listener refresh once to avoid
      // duplicate redraws and visible flicker after a drag-drop move.
      this.bus?.emit?.('files:changed', { action, from: source.path, to });
    } catch (e) {
      this.toasts.error(e.message);
    }
  }

  /**
   * Build the inline action area on the right of a row. Currently a single
   * three-dot button opens a context menu of actions specific to files or folders.
   */
  _renderRowActions(entry) {
    const wrap = document.createElement('span');
    wrap.className = 'row-actions';
    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'row-action-btn';
    menuBtn.title = this.i18n.t('files.more_actions');
    menuBtn.setAttribute('aria-label', this.i18n.t('files.more_actions'));
    menuBtn.append(Icon.render('fa fa-ellipsis-h'));
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._openMenu(menuBtn, entry);
    });
    wrap.appendChild(menuBtn);
    return wrap;
  }

  _openMenu(anchor, entry) {
    PopupMenu.open(anchor, this._menuItemsForEntry(entry));
  }

  _openMenuAt(x, y, entry) {
    PopupMenu.openAt(x, y, this._menuItemsForEntry(entry));
  }

  _menuItemsForEntry(entry) {
    const t = (k) => this.i18n.t(k);
    if (entry.type === 'dir') {
      return [
        { icon: 'fa fa-file-o', label: t('files.new_file_here'), onClick: () => this._createPrompt(entry.path, 'file') },
        { icon: 'fa fa-folder', label: t('files.new_folder_here'), onClick: () => this._createPrompt(entry.path, 'dir') },
        { sep: true },
        { icon: 'fa fa-clone', label: t('files.duplicate'), onClick: () => this._duplicate(entry) },
        { icon: 'fa fa-i-cursor', label: t('files.rename'), onClick: () => this._renamePrompt(entry) },
        { icon: 'fa fa-trash-o', label: t('files.delete'), onClick: () => this._delete(entry) },
        { sep: true },
        { icon: 'fa fa-upload', label: t('files.upload'), onClick: () => this._uploadInto(entry.path) },
        { icon: 'fa fa-file-archive-o', label: t('files.download_zip'), onClick: () => this._download(entry) },
      ];
    }

    return [
      { icon: 'fa fa-clone', label: t('files.duplicate'), onClick: () => this._duplicate(entry) },
      { icon: 'fa fa-i-cursor', label: t('files.rename'), onClick: () => this._renamePrompt(entry) },
      { icon: 'fa fa-trash-o', label: t('files.delete'), onClick: () => this._delete(entry) },
      { sep: true },
      { icon: 'fa fa-download', label: t('files.download'), onClick: () => this._download(entry) },
    ];
  }

  // ---- Actions ----------------------------------------------------------

  async _createPrompt(parentPath, type) {
    const parentLabel = parentPath === '' ? '/' : parentPath;
    const promptKey = type === 'dir' ? 'files.prompt_new_folder' : 'files.prompt_new_file';
    const name = window.prompt(this.i18n.t(promptKey, { parent: parentLabel }), '');
    if (name === null) return;
    const clean = String(name).trim().replace(/^\/+/, '');
    if (clean === '') return;
    const path = parentPath === '' ? clean : `${parentPath}/${clean}`;
    try {
      const res = await this.api.post('/files/create', { path, type });
      await this.refresh();
      this.bus?.emit?.('files:changed', { action: 'create', path: res?.path || path });
      if (type === 'file') {
        this.onOpen?.({ type: 'file', name: clean.split('/').pop(), path: res?.path || path });
      }
    } catch (e) {
      this.toasts.error(e.message);
    }
  }

  async _duplicate(entry) {
    try {
      const res = await this.api.post('/files/duplicate', { path: entry.path });
      await this.refresh();
      this.bus?.emit?.('files:changed', {
        action: 'duplicate',
        from: entry.path,
        to: res?.to || null,
      });
    } catch (e) {
      this.toasts.error(e.message);
    }
  }

  async _renamePrompt(entry) {
    const next = window.prompt(this.i18n.t('files.prompt_rename', { name: entry.name }), entry.name);
    if (next === null) return;
    const cleanName = String(next).trim();
    if (cleanName === '' || cleanName === entry.name) return;
    const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
    const to = parent === '' ? cleanName : `${parent}/${cleanName}`;
    try {
      await this.api.post('/files/move', { from: entry.path, to });
      await this.refresh();
      this.bus?.emit?.('files:changed', { action: 'rename', from: entry.path, to });
    } catch (e) {
      this.toasts.error(e.message);
    }
  }

  async _delete(entry) {
    const confirmMsg = this.i18n.t('files.confirm_delete', { path: entry.path });
    if (!window.confirm(confirmMsg)) return;
    try {
      await this.api.delete('/files/delete', { path: entry.path });
      await this.refresh();
      this.bus?.emit?.('files:changed', { action: 'delete', path: entry.path });
    } catch (e) {
      this.toasts.error(e.message);
    }
  }

  _download(entry) {
    this._downloadPath(entry.path, entry.name);
  }

  /**
   * Trigger a browser download for any path under the current workspace.
   * The backend zips folders automatically; passing an empty string targets
   * the workspace root.
   *
   * @param {string} path
   * @param {string} [fallbackName] Used only as a hint for the download attribute.
   */
  _downloadPath(path, fallbackName) {
    const url = this.api.url('/files/download', { path });
    const a = document.createElement('a');
    a.href = url;
    a.download = fallbackName || '';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  _uploadInto(targetPath) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      document.body.removeChild(input);
      if (files.length === 0) return;
      await this._uploadFiles(targetPath, files);
    });
    document.body.appendChild(input);
    input.click();
  }

  async _uploadFiles(targetPath, files) {
    const fd = new FormData();
    let i = 0;
    let hasZip = false;
    for (const file of files) {
      fd.append('file' + (i++), file, file.name);
      if (/\.zip$/i.test(file.name)) hasZip = true;
    }
    // If a single .zip was selected, offer to extract it on the server.
    let extract = false;
    if (hasZip && files.length === 1) {
      extract = window.confirm(
        `"${files[0].name}" is a ZIP archive. Extract it into the target folder?`
      );
    }
    try {
      const res = await this.api.request('POST', '/files/upload', {
        query: { path: targetPath, extract: extract ? 1 : 0 },
        body: fd,
      });
      const count = Array.isArray(res?.uploaded) ? res.uploaded.length : files.length;
      this.toasts.success?.(this.i18n.t('files.uploaded', { count }));
      await this.refresh();
      this.bus?.emit?.('files:changed', { action: 'upload', path: targetPath });
    } catch (e) {
      this.toasts.error(this.i18n.t('files.upload_failed') + ': ' + e.message);
    }
  }

  /**
   * Resolve a file icon spec from the configured `file_icons` map.
   * Lookup order: full filename (lower-case) → extension (lower-case) → default.
   *
   * @param {string} name
   * @returns {string}
   */
  _iconForFile(name) {
    const lower = String(name || '').toLowerCase();
    const byName = this.fileIcons.by_name || {};
    if (Object.prototype.hasOwnProperty.call(byName, lower)) {
      return byName[lower];
    }
    const dot = lower.lastIndexOf('.');
    if (dot > 0 && dot < lower.length - 1) {
      const ext = lower.slice(dot + 1);
      const byExt = this.fileIcons.by_ext || {};
      if (Object.prototype.hasOwnProperty.call(byExt, ext)) {
        return byExt[ext];
      }
    }
    return this.fileIcons.default || 'fa fa-file-o';
  }

  _selectRow(row) {
    this.host.querySelectorAll('.row.selected').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
  }
}

/**
 * Minimal popup menu anchored to a button. One instance is shown at a time:
 * opening a new menu closes any previous one. Closes on outside click,
 * Escape, scroll, or window resize.
 */
const PopupMenu = {
  current: null,

  open(anchor, items) {
    const rect = anchor.getBoundingClientRect();
    PopupMenu.openAt(rect.right, rect.bottom + 2, items, { flipYFrom: rect.top - 2 });
  },

  openAt(x, y, items, options = {}) {
    PopupMenu.close();
    const menu = document.createElement('div');
    menu.className = 'codiware-popup-menu';
    menu.setAttribute('role', 'menu');
    for (const item of items) {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'menu-sep';
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menu-item';
      btn.setAttribute('role', 'menuitem');
      btn.append(Icon.render(item.icon || ''));
      const label = document.createElement('span');
      label.textContent = item.label;
      btn.appendChild(label);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        PopupMenu.close();
        try { item.onClick?.(); } catch (err) { console.error(err); }
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);

    // Position near cursor/anchor; flip and clamp to keep the menu on-screen.
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = Math.min(x, window.innerWidth - mw - 4);
    if (left < 4) left = 4;
    let top = y;
    if (top + mh > window.innerHeight - 4) {
      const flipYFrom = typeof options.flipYFrom === 'number' ? options.flipYFrom : (y - 4);
      top = Math.max(4, flipYFrom - mh);
    }
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    const outside = (e) => {
      if (!menu.contains(e.target)) PopupMenu.close();
    };
    const onKey = (e) => { if (e.key === 'Escape') PopupMenu.close(); };
    const onScroll = () => PopupMenu.close();
    setTimeout(() => document.addEventListener('mousedown', outside), 0);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);

    PopupMenu.current = {
      menu,
      cleanup: () => {
        document.removeEventListener('mousedown', outside);
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('resize', onScroll);
        window.removeEventListener('scroll', onScroll, true);
      },
    };
  },

  close() {
    const c = PopupMenu.current;
    if (!c) return;
    PopupMenu.current = null;
    c.cleanup();
    c.menu.remove();
  },
};
