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
 * Normalize a workspace-relative directory path into the API format expected
 * by `/files/*` endpoints. Leading/trailing slashes are stripped so prompts
 * can accept either `Docs`, `/Docs` or `Docs/` without changing semantics.
 */
function normalizeRelativeDir(path) {
  return String(path || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Modal directory picker used by bulk move so users choose a target folder
 * from the workspace tree instead of typing a free-form path.
 */
class DirectoryPickerDialog {
  constructor({ api, i18n, toasts, title, confirmLabel, initialPath = '' }) {
    this.api = api;
    this.i18n = i18n;
    this.toasts = toasts || { error: (m) => console.error(m) };
    this.title = title;
    this.confirmLabel = confirmLabel;
    this.initialPath = normalizeRelativeDir(initialPath);
    this.selectedPath = this.initialPath;
    this.rowByPath = new Map();
    this.expanded = new Set(['']);
    this.modal = null;
    this.resolve = null;
    this.reject = null;
    this.onKeyDown = this._onKeyDown.bind(this);
  }

  /**
   * Open the picker, render the directory tree and resolve with the chosen
   * workspace-relative folder path or `null` when the dialog is cancelled.
   */
  async open() {
    return new Promise(async (resolve) => {
      this.resolve = resolve;
      this._buildShell();
      document.body.appendChild(this.modal);
      document.addEventListener('keydown', this.onKeyDown);
      await this._renderTree();
      this._syncSelectionUi();
      this.confirmBtn?.focus();
    });
  }

  _buildShell() {
    const overlay = document.createElement('div');
    overlay.className = 'codiware-modal-overlay';
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) this.close(null);
    });

    const dialog = document.createElement('div');
    dialog.className = 'codiware-modal codiware-dir-picker';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    const header = document.createElement('div');
    header.className = 'codiware-modal-header';
    const title = document.createElement('div');
    title.className = 'codiware-modal-title';
    title.textContent = this.title;
    header.appendChild(title);

    const body = document.createElement('div');
    body.className = 'codiware-modal-body';

    const hint = document.createElement('div');
    hint.className = 'codiware-dir-picker-hint';
    hint.textContent = this.i18n.t('files.move_picker_hint');
    body.appendChild(hint);

    this.currentPathEl = document.createElement('div');
    this.currentPathEl.className = 'codiware-dir-picker-current';
    body.appendChild(this.currentPathEl);

    this.treeEl = document.createElement('ul');
    this.treeEl.className = 'tree codiware-dir-picker-tree';
    body.appendChild(this.treeEl);

    const footer = document.createElement('div');
    footer.className = 'codiware-modal-footer';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'tb-btn';
    cancelBtn.textContent = this.i18n.t('actions.cancel');
    cancelBtn.addEventListener('click', () => this.close(null));

    this.confirmBtn = document.createElement('button');
    this.confirmBtn.type = 'button';
    this.confirmBtn.className = 'tb-btn primary';
    this.confirmBtn.textContent = this.confirmLabel;
    this.confirmBtn.addEventListener('click', () => this.close(this.selectedPath));

    footer.append(cancelBtn, this.confirmBtn);
    dialog.append(header, body, footer);
    overlay.appendChild(dialog);
    this.modal = overlay;
    this.dialog = dialog;
  }

  async _renderTree() {
    this.treeEl.innerHTML = '';
    this.rowByPath.clear();
    this.treeEl.appendChild(this._renderRootRow());
    await this._renderChildren(this.treeEl, '');
  }

  _renderRootRow() {
    const li = document.createElement('li');
    li.className = 'dir open';
    li.dataset.path = '';

    const row = document.createElement('span');
    row.className = 'row selected';
    row.dataset.path = '';
    row.dataset.entryType = 'dir';

    const spacer = document.createElement('span');
    spacer.className = 'ide-icon ide-icon-toggle';
    const icon = Icon.render('fa fa-folder-open');
    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = this.i18n.t('files.workspace_root');
    row.append(spacer, icon, name);
    row.addEventListener('click', () => this._selectPath(''));

    li.appendChild(row);
    this.rowByPath.set('', row);
    return li;
  }

  async _renderChildren(parentUl, path) {
    let data;
    try {
      data = await this.api.get('/files/tree', { path, foldersOnly: 1 });
    } catch (e) {
      this.toasts.error(e.message);
      return;
    }
    const entries = Array.isArray(data?.entries) ? data.entries.filter((entry) => entry.type === 'dir') : [];
    for (const entry of entries) {
      parentUl.appendChild(this._renderDir(entry));
    }
  }

  _renderDir(entry) {
    const li = document.createElement('li');
    li.className = 'dir';
    li.dataset.path = entry.path;

    const row = document.createElement('span');
    row.className = 'row';
    row.dataset.path = entry.path;
    row.dataset.entryType = 'dir';

    const toggle = Icon.render('fa fa-caret-right', { extraClass: 'ide-icon-toggle' });
    let folder = Icon.render('fa fa-folder');
    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = entry.name;
    row.append(toggle, folder, name);

    let childUl = null;
    let loaded = false;
    const canExpand = entry.has_children !== false;
    toggle.classList.toggle('is-placeholder', !canExpand);

    const setOpen = async (open) => {
      if (!canExpand) return;
      li.classList.toggle('open', open);
      toggle.firstElementChild?.classList.toggle('fa-caret-right', !open);
      toggle.firstElementChild?.classList.toggle('fa-caret-down', open);
      const replacement = Icon.render(open ? 'fa fa-folder-open' : 'fa fa-folder');
      folder.replaceWith(replacement);
      folder = replacement;
      if (open) {
        if (!childUl) {
          childUl = document.createElement('ul');
          li.appendChild(childUl);
        }
        if (!loaded) {
          loaded = true;
          await this._renderChildren(childUl, entry.path);
        }
        childUl.style.display = '';
        this.expanded.add(entry.path);
      } else if (childUl) {
        childUl.style.display = 'none';
        this.expanded.delete(entry.path);
      }
    };

    row.addEventListener('click', async (event) => {
      if (event.target.closest('.ide-icon-toggle')) {
        event.stopPropagation();
        if (!canExpand) return;
        await setOpen(!li.classList.contains('open'));
        return;
      }
      this._selectPath(entry.path);
    });

    if (this.expanded.has(entry.path) && canExpand) {
      setOpen(true);
    }

    li.appendChild(row);
    this.rowByPath.set(entry.path, row);
    return li;
  }

  _selectPath(path) {
    this.selectedPath = normalizeRelativeDir(path);
    this._syncSelectionUi();
  }

  _syncSelectionUi() {
    for (const [path, row] of this.rowByPath.entries()) {
      row.classList.toggle('selected', normalizeRelativeDir(path) === this.selectedPath);
    }
    if (this.currentPathEl) {
      const display = this.selectedPath === ''
        ? this.i18n.t('files.workspace_root')
        : this.selectedPath;
      this.currentPathEl.textContent = this.i18n.t('files.move_picker_selected', { path: display });
    }
  }

  _onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close(null);
    }
  }

  close(result) {
    if (this.modal?.parentNode) {
      this.modal.parentNode.removeChild(this.modal);
    }
    document.removeEventListener('keydown', this.onKeyDown);
    this.resolve?.(result);
    this.resolve = null;
  }
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
  constructor({ host, api, i18n, toasts, bus, onOpen, fileIcons, settings, filterMinChars }) {
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

    // Quick-search filter state. While a filter is active the tree shows only
    // files whose name matches the query, with every ancestor folder expanded.
    // The minimum number of characters before filtering kicks in is
    // configurable (`FILES.FILTER_MIN_CHARS`), defaulting to 3.
    this.filterMinChars = Math.max(1, parseInt(filterMinChars, 10) || 3);
    this.filterText = '';
    this._filterActive = false;
    this._filterDebounce = null;
    this._savedExpanded = null;

    // Paths of folders the user has expanded. Preserved across refreshes so
    // file operations (create/rename/delete/upload) do not collapse the tree,
    // and persisted in the repo-scoped settings store so they are restored
    // when the workspace is reopened in a new browser session.
    this.expanded = new Set(this._loadExpanded());
    this.dragContext = null;
    this.activeDropRow = null;
    this.selectionMode = false;
    this.selectedPaths = new Set();
    this.rowByPath = new Map();
    this._suspendRefreshOnce = false;

    this.host.innerHTML = '';
    this.host.classList.add('file-tree-host');

    this.toolbarEl = document.createElement('div');
    this.toolbarEl.className = 'panel-toolbar';
    this._buildToolbar();
    this.host.appendChild(this.toolbarEl);

    this.filterEl = document.createElement('div');
    this._buildFilter();
    this.host.appendChild(this.filterEl);

    // The tree lives inside a positioned wrapper so the blocking filter
    // overlay (spinner) can cover only the tree, leaving the toolbar and the
    // search field interactive.
    this.treeWrap = document.createElement('div');
    this.treeWrap.className = 'file-tree-scroll';

    this.rootUl = document.createElement('ul');
    this.rootUl.className = 'tree';
    this.treeWrap.appendChild(this.rootUl);

    this.overlay = document.createElement('div');
    this.overlay.className = 'file-tree-overlay';
    this.overlay.hidden = true;
    const spinner = document.createElement('div');
    spinner.className = 'file-tree-spinner';
    this.overlay.appendChild(spinner);
    this.treeWrap.appendChild(this.overlay);

    this.host.appendChild(this.treeWrap);

    this._scrollContainer = (this.host.closest && this.host.closest('.ide-sidebar-content')) || this.host;
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

  /**
   * Build the explorer toolbar and keep references to buttons that need to
   * react to selection-mode changes and multi-selection capabilities.
   */
  _buildToolbar() {
    this.newFileBtn = this._tbBtn('fa fa-file-o', this.i18n.t('files.new_file'), () => this._createPrompt('', 'file'));
    this.newFolderBtn = this._tbBtn('fa fa-folder', this.i18n.t('files.new_folder'), () => this._createPrompt('', 'dir'));
    this.uploadBtn = this._tbBtn('fa fa-upload', this.i18n.t('files.upload'), () => this._uploadInto(''));
    this.downloadWorkspaceBtn = this._tbBtn('fa fa-file-archive-o', this.i18n.t('files.download_zip'), () => this._downloadPath('', 'workspace'));
    this.selectionModeBtn = this._tbBtn('fa fa-check-square-o', this.i18n.t('files.selection_mode_enable'), () => this._toggleSelectionMode());
    this.moveSelectedBtn = this._tbBtn('fa fa-folder-open-o', this.i18n.t('files.move_selected'), () => this._moveSelectedPrompt());
    this.downloadSelectedBtn = this._tbBtn('fa fa-download', this.i18n.t('files.download_selected'), () => this._downloadSelected());
    this.deleteSelectedBtn = this._tbBtn('fa fa-trash-o', this.i18n.t('files.delete_selected'), () => this._deleteSelected());
    this.refreshBtn = this._tbBtn('fa fa-refresh', this.i18n.t('actions.refresh'), () => this.refresh());

    this.toolbarEl.append(
      this.newFileBtn,
      this.newFolderBtn,
      this.uploadBtn,
      this.downloadWorkspaceBtn,
      this.selectionModeBtn,
      this.moveSelectedBtn,
      this.downloadSelectedBtn,
      this.deleteSelectedBtn,
      this.refreshBtn,
    );
    this._updateSelectionModeUi();
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

  /**
   * Enable or disable the checkbox-based multi-selection mode. Leaving the
   * mode clears the selection so the tree returns to the normal single-row
   * interaction model immediately.
   */
  _toggleSelectionMode(force) {
    const next = typeof force === 'boolean' ? force : !this.selectionMode;
    if (this.selectionMode === next) return;
    this.selectionMode = next;
    if (!next) {
      this.selectedPaths.clear();
    }
    this._syncSelectionUi();
    this._updateSelectionModeUi();
  }

  /**
   * Recalculate toolbar states and the highlighted toggle button for the
   * current selection mode / selected item count.
   */
  _updateSelectionModeUi() {
    const selectedCount = this.selectedPaths.size;
    if (this.selectionModeBtn) {
      this.selectionModeBtn.classList.toggle('primary', this.selectionMode);
      const title = this.selectionMode
        ? this.i18n.t('files.selection_mode_disable')
        : this.i18n.t('files.selection_mode_enable');
      this.selectionModeBtn.title = title;
      this.selectionModeBtn.setAttribute('aria-label', title);
    }
    if (this.moveSelectedBtn) this.moveSelectedBtn.disabled = !this.selectionMode || selectedCount === 0;
    if (this.downloadSelectedBtn) this.downloadSelectedBtn.disabled = !this.selectionMode || selectedCount === 0;
    if (this.deleteSelectedBtn) this.deleteSelectedBtn.disabled = !this.selectionMode || selectedCount === 0;
  }

  /**
   * Synchronize every rendered row with the current multi-selection state,
   * including checkbox visibility, checked markers and selection highlight.
   */
  _syncSelectionUi() {
    for (const [path, row] of this.rowByPath.entries()) {
      const cb = row.querySelector('.tree-select-checkbox');
      if (cb) {
        cb.hidden = !this.selectionMode;
        cb.checked = this.selectedPaths.has(path);
      }
      row.classList.toggle('is-selection-mode', this.selectionMode);
      row.classList.toggle('selected', this.selectedPaths.has(path));
    }
    this.host.classList.toggle('is-selection-mode', this.selectionMode);
    this._updateSelectionModeUi();
  }

  /**
   * Register or refresh a row reference so later mode changes can update the
   * row without re-rendering the entire tree.
   */
  _bindRow(entry, row) {
    this.rowByPath.set(entry.path, row);
    row.dataset.path = entry.path;
    row.dataset.entryType = entry.type;
    row.classList.toggle('selected', this.selectedPaths.has(entry.path));
    row.classList.toggle('is-selection-mode', this.selectionMode);
    const cb = row.querySelector('.tree-select-checkbox');
    if (cb) {
      cb.hidden = !this.selectionMode;
      cb.checked = this.selectedPaths.has(entry.path);
    }
  }

  /**
   * Return the tree entries currently selected for bulk actions. When the
   * mode is active and the clicked row is among the checked ones, drag/drop
   * and menus operate on the whole set; otherwise they fall back to the one
   * explicit entry.
   */
  _entriesForAction(entry) {
    if (!this.selectionMode || this.selectedPaths.size === 0 || !entry?.path || !this.selectedPaths.has(entry.path)) {
      return [entry];
    }
    return this._entriesFromPaths(this.selectedPaths);
  }

  /**
   * Rebuild entry descriptors from a set of selected paths using the current
   * rendered rows, then prune descendants so bulk actions run once per top-
   * level selection only.
   */
  _entriesFromPaths(paths) {
    const entries = [];
    const seen = new Set();
    for (const path of paths || []) {
      if (typeof path !== 'string' || path === '' || seen.has(path)) continue;
      seen.add(path);
      const row = this.rowByPath.get(path);
      const type = row?.dataset?.entryType || 'file';
      const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
      entries.push({ path, name, type });
    }
    return this._filterTopLevelEntries(entries);
  }

  /**
   * Remove descendant entries from a bulk-selection list so directory moves or
   * deletes are executed only once at the highest selected ancestor.
   */
  _filterTopLevelEntries(entries) {
    const sorted = (entries || []).slice().sort((a, b) => a.path.localeCompare(b.path));
    return sorted.filter((entry, index, list) => {
      for (let i = 0; i < index; i += 1) {
        const parentPath = list[i].path;
        if (entry.path === parentPath || entry.path.startsWith(parentPath + '/')) {
          return false;
        }
      }
      return true;
    });
  }

  /**
   * Toggle one row inside the current bulk selection and immediately reflect
   * the change in checkbox state and row highlight.
   */
  _toggleEntrySelection(entry, row, checked) {
    if (checked) this.selectedPaths.add(entry.path);
    else this.selectedPaths.delete(entry.path);
    row.classList.toggle('selected', checked);
    const cb = row.querySelector('.tree-select-checkbox');
    if (cb) cb.checked = checked;
    this._updateSelectionModeUi();
  }

  /**
   * Return a pruned copy of the selection that still exists in the currently
   * rendered tree. This keeps bulk actions stable after moves/refreshes.
   */
  _pruneSelection() {
    const next = new Set();
    for (const path of this.selectedPaths) {
      if (this.rowByPath.has(path)) next.add(path);
    }
    this.selectedPaths = next;
  }

  /**
   * Merge new paths into the multi-selection after a successful bulk move/copy
   * so follow-up actions work without forcing the user to toggle the mode.
   */
  _replaceSelectionPaths(operations, { keepSources = false } = {}) {
    if (!Array.isArray(operations) || operations.length === 0) return;
    const next = keepSources ? new Set(this.selectedPaths) : new Set();
    const sourceSet = new Set(operations.map((op) => op.from));
    if (keepSources) {
      sourceSet.forEach((path) => next.delete(path));
    }
    operations.forEach((op) => {
      if (typeof op?.to === 'string' && op.to !== '') {
        next.add(op.to);
      }
    });
    this.selectedPaths = next;
  }

  /**
   * Return all selected paths, not just the top-level subset used for the real
   * bulk operation. Confirmation text uses this so counts stay correct even
   * when the clicked row lives inside only one branch of the selection.
   */
  _selectionDisplayCount() {
    return Array.from(this.selectedPaths).filter((path) => typeof path === 'string' && path !== '').length;
  }

  /**
   * Expand the parent chain and the target directory itself after a move so
   * newly moved files become visible immediately, even if the destination was
   * collapsed before the operation.
   */
  _ensurePathExpanded(path) {
    const normalized = normalizeRelativeDir(path);
    if (normalized === '') return;
    const parts = normalized.split('/');
    let current = '';
    for (const part of parts) {
      current = current === '' ? part : `${current}/${part}`;
      this.expanded.add(current);
    }
    this._persistExpanded();
  }

  async refresh() {
    this.rowByPath.clear();
    this.selectedPaths = new Set(Array.from(this.selectedPaths).filter((path) => typeof path === 'string'));
    // Keep the tree filtered across refreshes triggered by saving a file or
    // by file operations, as long as a valid filter query is active.
    if (this._filterActive && this.filterText.trim().length >= this.filterMinChars) {
      await this._applyFilter();
      this._pruneSelection();
      this._syncSelectionUi();
      return;
    }
    this.rootUl.innerHTML = '';
    await this._renderInto(this.rootUl, '');
    await this._restoreExpansion();
    this._pruneSelection();
    this._syncSelectionUi();
  }

  // ---- Quick-search filter ---------------------------------------------

  _buildFilter() {
    this.filterEl.className = 'file-tree-filter history-search';
    this.filterEl.append(Icon.render('fa fa-search'));

    const placeholder = this.i18n.t('files.filter_placeholder');
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'file-tree-filter-input history-search-input';
    input.placeholder = placeholder;
    input.setAttribute('aria-label', placeholder);
    input.value = this.filterText;
    input.addEventListener('input', () => {
      this.filterText = input.value || '';
      this._scheduleFilter();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.value !== '') {
        e.preventDefault();
        input.value = '';
        this.filterText = '';
        this._scheduleFilter(true);
      }
    });
    this.filterInput = input;
    this.filterEl.append(input);
  }

  _scheduleFilter(immediate = false) {
    if (this._filterDebounce) {
      clearTimeout(this._filterDebounce);
      this._filterDebounce = null;
    }
    const run = () => {
      this._filterDebounce = null;
      this._applyFilter();
    };
    if (immediate) run();
    else this._filterDebounce = setTimeout(run, 200);
  }

  async _applyFilter() {
    const query = this.filterText.trim();
    // Below the configured threshold: clear the filter and restore the tree.
    if (query.length < this.filterMinChars) {
      if (this._filterActive) await this._clearFilter();
      return;
    }
    // Remember the unfiltered expansion state once, so it can be restored when
    // the filter is cleared.
    if (!this._filterActive) {
      this._savedExpanded = new Set(this.expanded);
      this._filterActive = true;
    }
    this._showOverlay();
    try {
      const data = await this.api.get('/files/find', { q: query });
      // Ignore stale responses if the query changed while the request was in
      // flight (a newer one will render the correct result).
      if (this.filterText.trim() !== query) return;
      const matches = Array.isArray(data?.matches) ? data.matches : [];
      this._renderFiltered(matches, data?.truncated === true);
    } catch (e) {
      this.rootUl.innerHTML = '';
      const li = document.createElement('li');
      li.textContent = e.message;
      li.style.color = '#c0392b';
      this.rootUl.appendChild(li);
    } finally {
      this._hideOverlay();
    }
  }

  async _clearFilter() {
    this._filterActive = false;
    if (this._savedExpanded) {
      this.expanded = new Set(this._savedExpanded);
      this._savedExpanded = null;
      this._persistExpanded();
    }
    await this.refresh();
  }

  _showOverlay() {
    if (!this.overlay) return;
    try { this._scrollContainer.scrollTop = 0; } catch (e) { /* ignore */ }
    this.overlay.hidden = false;
    this.host.classList.add('is-filtering');
  }

  _hideOverlay() {
    if (!this.overlay) return;
    this.overlay.hidden = true;
    this.host.classList.remove('is-filtering');
  }

  /**
   * Render the filtered result set. The flat list of matching files is turned
   * into a nested folder hierarchy (derived from each file's path) so every
   * match is shown with its complete ancestor chain, fully expanded. Folders
   * without matching files never appear.
   */
  _renderFiltered(matches, truncated) {
    this.rootUl.innerHTML = '';
    this.rowByPath.clear();
    if (matches.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = this.i18n.t('files.no_matches');
      li.style.opacity = '0.6';
      this.rootUl.appendChild(li);
      return;
    }

    const rootNode = { dirs: new Map(), files: [] };
    for (const m of matches) {
      const parts = String(m.path || '').split('/');
      const fileName = parts.pop();
      let node = rootNode;
      let acc = '';
      for (const part of parts) {
        acc = acc === '' ? part : acc + '/' + part;
        if (!node.dirs.has(part)) {
          node.dirs.set(part, { name: part, path: acc, dirs: new Map(), files: [] });
        }
        node = node.dirs.get(part);
      }
      node.files.push({ ...m, name: m.name || fileName });
    }

    this._renderFilteredNode(rootNode, this.rootUl);
    this._pruneSelection();
    this._syncSelectionUi();

    if (truncated) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.style.opacity = '0.6';
      li.textContent = this.i18n.t('files.too_many_matches');
      this.rootUl.appendChild(li);
    }
  }

  _renderFilteredNode(node, ul) {
    const dirs = Array.from(node.dirs.values()).sort((a, b) => a.name.localeCompare(b.name));
    for (const dir of dirs) {
      ul.appendChild(this._renderFilteredDir(dir));
    }
    const files = node.files.slice().sort((a, b) => a.name.localeCompare(b.name));
    for (const f of files) {
      ul.appendChild(this._renderEntry({ type: 'file', name: f.name, path: f.path, is_text: f.is_text }));
    }
  }

  _renderFilteredDir(dir) {
    const li = document.createElement('li');
    li.className = 'dir open';
    li.dataset.path = dir.path;

    const row = document.createElement('span');
    row.className = 'row';
    row.dataset.entryType = 'dir';

    const entry = { type: 'dir', path: dir.path, name: dir.name };
    const checkbox = this._createSelectionCheckbox(entry, row);
    const toggle = Icon.render('fa fa-caret-down', { extraClass: 'ide-icon-toggle' });
    const folderSpec = this.fileIcons.folder || 'fa fa-folder';
    const folderOpenSpec = this.fileIcons.folder_open || folderSpec;
    let folder = Icon.render(folderOpenSpec);
    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = dir.name;
    row.append(checkbox, toggle, folder, name);

    const childUl = document.createElement('ul');
    this._renderFilteredNode(dir, childUl);

    // In filtered mode folders only toggle their visibility; their children are
    // already in the DOM, so no server round-trip is needed.
    row.addEventListener('click', (e) => {
      if (e.target.closest('.row-actions') || e.target.closest('.tree-select-checkbox')) return;
      if (this.selectionMode && !e.target.closest('.ide-icon-toggle')) return;
      const open = !li.classList.contains('open');
      li.classList.toggle('open', open);
      toggle.firstElementChild?.classList.toggle('fa-caret-right', !open);
      toggle.firstElementChild?.classList.toggle('fa-caret-down', open);
      const replacement = Icon.render(open ? folderOpenSpec : folderSpec);
      folder.replaceWith(replacement);
      folder = replacement;
      childUl.style.display = open ? '' : 'none';
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._selectRow(row);
      this._openMenuAt(e.clientX, e.clientY, entry);
    });

    row.appendChild(this._renderRowActions(entry));
    li.appendChild(row);
    li.appendChild(childUl);
    this._bindRow(entry, row);
    return li;
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

  /**
   * Create the optional selection checkbox shown in bulk-selection mode.
   * Clicking the checkbox never triggers row open/toggle handlers.
   */
  _createSelectionCheckbox(entry, row) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'tree-select-checkbox';
    checkbox.hidden = !this.selectionMode;
    checkbox.checked = this.selectedPaths.has(entry.path);
    checkbox.title = this.i18n.t('files.select_item');
    checkbox.setAttribute('aria-label', this.i18n.t('files.select_item'));
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      this._toggleEntrySelection(entry, row, checkbox.checked);
    });
    return checkbox;
  }

  _renderEntry(entry) {
    const li = document.createElement('li');
    li.className = entry.type === 'dir' ? 'dir' : 'file';
    li.dataset.path = entry.path;

    const row = document.createElement('span');
    row.className = 'row';
    row.dataset.entryType = entry.type;
    const checkbox = this._createSelectionCheckbox(entry, row);

    if (entry.type === 'dir') {
      const hasChildren = entry.has_children !== false;
      const toggle = Icon.render('fa fa-caret-right', { extraClass: 'ide-icon-toggle' });
      toggle.classList.toggle('is-placeholder', !hasChildren);
      const folderIconSpec = this.fileIcons.folder || 'fa fa-folder';
      const folderOpenSpec = this.fileIcons.folder_open || folderIconSpec;
      let folder = Icon.render(folderIconSpec);
      const name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = entry.name;
      row.append(checkbox, toggle, folder, name);

      // Toggle helper bound to this <li>; reused by user clicks and by
      // `_restoreExpansion()` after a refresh.
      const setOpen = async (open) => {
        if (!hasChildren) return;
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
        if (e.target.closest('.row-actions') || e.target.closest('.tree-select-checkbox')) return;
        if (this.selectionMode && !e.target.closest('.ide-icon-toggle')) return;
        if (!hasChildren) return;
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
      const spacer = document.createElement('span');
      spacer.className = 'ide-icon ide-icon-toggle';
      row.append(checkbox, spacer, file, name);
      row.addEventListener('click', (e) => {
        if (e.target.closest('.row-actions') || e.target.closest('.tree-select-checkbox')) return;
        this._selectRow(row);
        if (this.selectionMode) return;
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
    this._bindRow(entry, row);
    return li;
  }

  _setupDragSource(row, entry) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      if (e.target.closest('.row-actions') || e.target.closest('.tree-select-checkbox')) {
        e.preventDefault();
        return;
      }
      const entries = this._entriesForAction(entry);
      this.dragContext = {
        entry,
        entries,
        copy: !!(e.ctrlKey || e.metaKey),
      };
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', entries.map((item) => item.path).join('\n'));
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
    const sources = Array.isArray(drag.entries) && drag.entries.length > 0 ? drag.entries : [drag.entry];
    if (!sources.every((source) => this._canDropInto(source, targetDir))) return null;
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

  /**
   * Execute one drag/drop move or copy operation for every selected top-level
   * source entry and emit a single change event afterwards.
   */
  async _performDrop(targetDir, evt) {
    const drag = this.dragContext;
    if (!drag) return;
    const sources = Array.isArray(drag.entries) && drag.entries.length > 0 ? drag.entries : [drag.entry];

    const copy = !!(evt.ctrlKey || evt.metaKey || drag.copy);
    const endpoint = copy ? '/files/copy' : '/files/move';
    const action = copy ? 'copy' : 'move';
    const operations = [];

    for (const source of sources) {
      const name = source.path.split('/').pop();
      const to = targetDir === '' ? name : `${targetDir}/${name}`;
      if (to === source.path) continue;
      operations.push({ from: source.path, to, type: source.type });
    }
    if (operations.length === 0) return;

    try {
      for (const op of operations) {
        await this.api.post(endpoint, { from: op.from, to: op.to });
      }
      if (!copy) {
        this._ensurePathExpanded(targetDir);
      }
      this._replaceSelectionPaths(operations, { keepSources: false });
      this._suspendRefreshOnce = true;
      await this.refresh();
      this.bus?.emit?.('files:changed', {
        action,
        items: operations.map(({ from, to, type }) => ({ from, to, type })),
      });
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

  /**
   * Build a row menu that can switch between single-entry actions and the
   * reduced bulk-action set when the clicked row belongs to an active bulk
   * selection. Single selected items keep the normal item menu even while
   * selection mode is enabled so directory/file specific actions stay usable.
   */
  _menuItemsForEntry(entry) {
    const t = (k) => this.i18n.t(k);
    const isBulk = this.selectionMode && this.selectedPaths.size > 1 && this.selectedPaths.has(entry.path);
    if (isBulk) {
      const selectedEntries = this._entriesFromPaths(this.selectedPaths);
      return [
        { icon: 'fa fa-folder-open-o', label: t('files.move_selected'), onClick: () => this._moveEntriesPrompt(selectedEntries) },
        { icon: 'fa fa-download', label: t('files.download_selected'), onClick: () => this._downloadEntries(selectedEntries) },
        { icon: 'fa fa-trash-o', label: t('files.delete_selected'), onClick: () => this._deleteEntries(selectedEntries) },
      ];
    }

    if (entry.type === 'dir') {
      return [
        { icon: 'fa fa-file-o', label: t('files.new_file_here'), onClick: () => this._createPrompt(entry.path, 'file') },
        { icon: 'fa fa-folder', label: t('files.new_folder_here'), onClick: () => this._createPrompt(entry.path, 'dir') },
        { sep: true },
        { icon: 'fa fa-clipboard', label: t('files.copy_relative_path'), onClick: () => this._copyPathToClipboard(entry.path) },
        { icon: 'fa fa-clone', label: t('files.duplicate'), onClick: () => this._duplicate(entry) },
        { icon: 'fa fa-i-cursor', label: t('files.rename'), onClick: () => this._renamePrompt(entry) },
        { icon: 'fa fa-trash-o', label: t('files.delete'), onClick: () => this._delete(entry) },
        { sep: true },
        { icon: 'fa fa-upload', label: t('files.upload'), onClick: () => this._uploadInto(entry.path) },
        { icon: 'fa fa-file-archive-o', label: t('files.download_zip'), onClick: () => this._download(entry) },
      ];
    }

    return [
      { icon: 'fa fa-history', label: t('git.open_file_history'), onClick: () => this.bus?.emit?.('git:open-file-history', { path: entry.path }) },
      { sep: true },
      { icon: 'fa fa-clipboard', label: t('files.copy_relative_path'), onClick: () => this._copyPathToClipboard(entry.path) },
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
    const suggestion = this._suggestDuplicateName(entry.name, entry.type);
    const nextName = window.prompt(this.i18n.t('files.prompt_duplicate', { name: entry.name }), suggestion);
    if (nextName === null) return;
    const cleanName = String(nextName).trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (cleanName === '') return;

    const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
    const targetPath = parent === '' ? cleanName : `${parent}/${cleanName}`;
    if (targetPath === entry.path) return;

    try {
      const res = await this.api.post('/files/copy', { from: entry.path, to: targetPath });
      await this.refresh();
      this.bus?.emit?.('files:changed', {
        action: 'duplicate',
        from: entry.path,
        to: res?.to || targetPath,
      });
    } catch (e) {
      this.toasts.error(e.message);
    }
  }

  _suggestDuplicateName(name, type) {
    if (type === 'dir') {
      return `${name}_copy`;
    }
    const dot = name.lastIndexOf('.');
    if (dot <= 0 || dot === name.length - 1) {
      return `${name}_copy`;
    }
    return `${name.slice(0, dot)}_copy${name.slice(dot)}`;
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
    await this._deleteEntries([entry]);
  }

  /**
   * Delete all currently selected entries after one shared confirmation
   * message. Descendants of selected folders are ignored automatically.
   */
  async _deleteEntries(entries) {
    const topLevelEntries = this._filterTopLevelEntries(entries);
    if (topLevelEntries.length === 0) return;
    const displayCount = this.selectionMode ? this._selectionDisplayCount() : topLevelEntries.length;
    const single = displayCount === 1 && topLevelEntries.length === 1;
    const confirmMsg = single
      ? this.i18n.t('files.confirm_delete', { path: topLevelEntries[0].path })
      : this.i18n.t('files.confirm_delete_multiple', { count: displayCount });
    if (!window.confirm(confirmMsg)) return;
    try {
      for (const entry of topLevelEntries) {
        await this.api.delete('/files/delete', { path: entry.path });
      }
      topLevelEntries.forEach((entry) => this.selectedPaths.delete(entry.path));
      await this.refresh();
      this.bus?.emit?.('files:changed', {
        action: 'delete',
        items: topLevelEntries.map((entry) => ({ path: entry.path, type: entry.type })),
      });
    } catch (e) {
      this.toasts.error(e.message);
    }
  }

  _deleteSelected() {
    this._deleteEntries(this._entriesForSelectionMode());
  }

  /**
   * Return the currently selected top-level entries for toolbar-triggered bulk
   * actions.
   */
  _entriesForSelectionMode() {
    return this._entriesFromPaths(this.selectedPaths);
  }

  async _copyPathToClipboard(path) {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(path);
      } else {
        this._copyTextFallback(path);
      }
      this.toasts.success?.(this.i18n.t('files.path_copied'));
    } catch (e) {
      try {
        this._copyTextFallback(path);
        this.toasts.success?.(this.i18n.t('files.path_copied'));
      } catch (fallbackError) {
        this.toasts.error(this.i18n.t('files.path_copy_failed'));
      }
    }
  }

  _copyTextFallback(text) {
    const input = document.createElement('textarea');
    input.value = text;
    input.setAttribute('readonly', 'readonly');
    input.style.position = 'fixed';
    input.style.top = '-9999px';
    input.style.left = '-9999px';
    document.body.appendChild(input);
    input.focus();
    input.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(input);
    if (!ok) {
      throw new Error('Copy command rejected');
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

  /**
   * Download the selected top-level items as one ZIP archive through the new
   * repeated `paths[]` API contract, preserving their relative structure.
   */
  _downloadEntries(entries) {
    const topLevelEntries = this._filterTopLevelEntries(entries);
    if (topLevelEntries.length === 0) return;
    if (topLevelEntries.length === 1) {
      this._download(topLevelEntries[0]);
      return;
    }
    const query = { 'paths[]': topLevelEntries.map((entry) => entry.path) };
    const a = document.createElement('a');
    a.href = this.api.url('/files/download', query);
    a.download = 'selection.zip';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  _downloadSelected() {
    this._downloadEntries(this._entriesForSelectionMode());
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
   * Ask the user for one target directory through a folder picker and move
   * every selected top-level entry into that directory using `/files/move`.
   */
  async _moveEntriesPrompt(entries) {
    const topLevelEntries = this._filterTopLevelEntries(entries);
    if (topLevelEntries.length === 0) return;

    const picker = new DirectoryPickerDialog({
      api: this.api,
      i18n: this.i18n,
      toasts: this.toasts,
      title: this.i18n.t('files.move_picker_title'),
      confirmLabel: this.i18n.t('actions.move'),
      initialPath: '',
    });
    const targetDir = await picker.open();
    if (targetDir === null) return;

    const operations = [];
    for (const entry of topLevelEntries) {
      const name = entry.path.split('/').pop();
      const to = targetDir === '' ? name : `${targetDir}/${name}`;
      if (to === entry.path || !this._canDropInto(entry, targetDir)) continue;
      operations.push({ from: entry.path, to, type: entry.type });
    }
    if (operations.length === 0) return;

    try {
      for (const op of operations) {
        await this.api.post('/files/move', { from: op.from, to: op.to });
      }
      this._ensurePathExpanded(targetDir);
      this._replaceSelectionPaths(operations, { keepSources: false });
      await this.refresh();
      this.bus?.emit?.('files:changed', { action: 'move', items: operations });
    } catch (e) {
      this.toasts.error(e.message);
    }
  }

  _moveSelectedPrompt() {
    this._moveEntriesPrompt(this._entriesForSelectionMode());
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
    if (this.selectionMode) return;
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
