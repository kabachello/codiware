/** Source-control sidebar panel (Git-Panel). */
import { Icon } from '../core/Icon.js';
import { PopupMenu } from '../core/PopupMenu.js';

const FETCH_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>source-branch-sync</title><path d="M13 14C9.64 14 8.54 15.35 8.18 16.24C9.25 16.7 10 17.76 10 19C10 20.66 8.66 22 7 22S4 20.66 4 19C4 17.69 4.83 16.58 6 16.17V7.83C4.83 7.42 4 6.31 4 5C4 3.34 5.34 2 7 2S10 3.34 10 5C10 6.31 9.17 7.42 8 7.83V13.12C8.88 12.47 10.16 12 12 12C14.67 12 15.56 10.66 15.85 9.77C14.77 9.32 14 8.25 14 7C14 5.34 15.34 4 17 4S20 5.34 20 7C20 8.34 19.12 9.5 17.91 9.86C17.65 11.29 16.68 14 13 14M7 18C6.45 18 6 18.45 6 19S6.45 20 7 20 8 19.55 8 19 7.55 18 7 18M7 4C6.45 4 6 4.45 6 5S6.45 6 7 6 8 5.55 8 5 7.55 4 7 4M17 6C16.45 6 16 6.45 16 7S16.45 8 17 8 18 7.55 18 7 17.55 6 17 6M18 13V14.5C20.21 14.5 22 16.29 22 18.5C22 19.32 21.75 20.08 21.33 20.71L20.24 19.62C20.41 19.28 20.5 18.9 20.5 18.5C20.5 17.12 19.38 16 18 16V17.5L15.75 15.25L15.72 15.22C15.78 15.17 15.85 15.13 18 13M18 24V22.5C15.79 22.5 14 20.71 14 18.5C14 17.68 14.25 16.92 14.67 16.29L15.76 17.38C15.59 17.72 15.5 18.1 15.5 18.5C15.5 19.88 16.62 21 18 21V19.5L20.25 21.75L20.28 21.78C20.22 21.83 20.15 21.87 18 24" /></svg>';

export class GitPanel {
  constructor({ api, i18n, toasts, bus, onOpenDiff, onOpenHistory, onOpenFile, user = {}, hasGitIdentity = true, initialStatus = null }) {
    this.api = api;
    this.i18n = i18n;
    this.toasts = toasts;
    this.bus = bus;
    this.onOpenDiff = onOpenDiff;
    this.onOpenHistory = typeof onOpenHistory === 'function' ? onOpenHistory : () => {};
    this.onOpenFile = typeof onOpenFile === 'function' ? onOpenFile : () => {};
    this.user = user || {};
    this.hasGitIdentity = Boolean(hasGitIdentity);
    this.filterText = '';
    this._lastStatus = initialStatus || null;
    this._branchMenuLoading = false;
    this._statusRequestSeq = 0;
    bus.on('file:saved', () => this.refresh());
  }

  /** Render the Git panel shell and load the current repository status. */
  mount(host) {
    this.host = host;
    host.innerHTML = '';

    const toolbar = el('div', 'panel-toolbar');
    this.pushBtn = this._tbBtn('fa fa-cloud-upload', this.i18n.t('git.push'), () => this.push());
    this.pullBtn = this._tbBtn('fa fa-cloud-download', this.i18n.t('git.pull'), () => this.pull());
    this.fetchBtn = this._tbBtn(FETCH_ICON, this.i18n.t('git.fetch_all') || 'Update remote branches and tags', () => this.fetch());
    toolbar.append(
      this._tbBtn('fa fa-refresh', this.i18n.t('actions.refresh'), () => this.refresh()),
      this.pushBtn,
      this.pullBtn,
      this.fetchBtn,
      this._tbBtn('fa fa-history', this.i18n.t('git.history'), () => this.onOpenHistory())
    );

    this.identityWarning = null;
    if (this._isIdentityMissing()) {
      this.identityWarning = el('div', 'git-identity-warning');
      const warningIcon = Icon.render('fa fa-exclamation-triangle');
      warningIcon.setAttribute('aria-hidden', 'true');
      this.identityWarning.append(warningIcon, document.createTextNode(this.i18n.t('git.identity_missing_warning') || 'Git user name or email is missing. Commits may fail.'));
    }

    this.msg = document.createElement('textarea');
    this.msg.placeholder = this.i18n.t('git.commit_message');
    this.msg.rows = 2;
    this.msg.style.width = '100%';

    const commitRow = el('div', 'panel-toolbar');
    commitRow.style.display = 'flex';
    commitRow.style.gap = '4px';
    commitRow.style.marginTop = '4px';
    this.commitBtn = btn(this.i18n.t('git.commit'), () => this.commit(false));
    commitRow.append(this.commitBtn, btn(this.i18n.t('git.amend'), () => this.commit(true)));

    this.body = el('div', 'git-status-list');
    this.filterWrap = null;
    this.filterInput = null;
    host.append(toolbar);
    if (this.identityWarning) host.append(this.identityWarning);
    host.append(this.msg, commitRow, this.body);

    this._collapsed = { staged: false, changed: false, untracked: false };
    if (this._lastStatus) {
      this._applyStatus(this._lastStatus);
      return;
    }
    this.refresh();
  }

  /** Refresh status from the Git API and re-render all status-dependent UI. */
  async refresh() {
    if (!this.body) return;
    const requestSeq = ++this._statusRequestSeq;
    this.body.textContent = '…';
    try {
      const data = await this.api.get('/git/status');
      // Ignore stale refresh responses. A stage/unstage operation can finish
      // while an older status request is still running; the older result must
      // not overwrite the newer post-action panel state.
      if (requestSeq !== this._statusRequestSeq) return;
      this._applyStatus(data, { invalidatePending: false });
    } catch (e) {
      if (requestSeq === this._statusRequestSeq) this.body.textContent = e.message;
    }
  }

  /** Store one status payload, broadcast it and update buttons/list rendering. */
  _applyStatus(data, { invalidatePending = true } = {}) {
    if (invalidatePending) this._statusRequestSeq += 1;
    const status = this._normalizeStatus(data);
    this._lastStatus = status;
    this.bus?.emit?.('git:status-updated', status);
    this._updatePushButton(status);
    this._updatePullButton(status);
    this._updateCommitButton(status);
    try {
      this.render(status);
    } catch (e) {
      console.error('[GitPanel] render failed:', e);
      if (this.body) this.body.textContent = e?.message || String(e);
    }
  }

  /** Normalize API payloads into the complete status shape expected by render(). */
  _normalizeStatus(data) {
    const payload = data?.status && typeof data.status === 'object' ? data.status : (data || {});
    const files = Array.isArray(payload.files) ? payload.files.filter(Boolean) : [];
    return {
      branch: payload.branch ?? null,
      upstream: payload.upstream ?? null,
      ahead: Number(payload.ahead || 0),
      behind: Number(payload.behind || 0),
      unpublished: Boolean(payload.unpublished),
      publish_remote: payload.publish_remote ?? null,
      clean: files.length === 0,
      files,
    };
  }

  /** Promote unpublished branches as publishable even before Git reports ahead. */
  _updatePushButton(status) {
    const unpublished = Boolean(status?.unpublished);
    const label = unpublished ? (this.i18n.t('git.push_branch') || 'Push branch') : this.i18n.t('git.push');
    this._updateSyncButton(this.pushBtn, label, unpublished ? 1 : Number(status?.ahead || 0), { showCount: !unpublished });
  }
  _updatePullButton(status) { this._updateSyncButton(this.pullBtn, this.i18n.t('git.pull'), Number(status?.behind || 0)); }

  /** Promote push/pull buttons when there is work in that direction. */
  _updateSyncButton(button, baseLabel, count, { showCount = true } = {}) {
    if (!button) return;
    const hasWork = count > 0;
    button.classList.toggle('primary', hasWork);
    let label = button.querySelector('.tb-btn-label');
    if (hasWork) {
      if (!label) {
        label = document.createElement('span');
        label.className = 'tb-btn-label';
        button.append(label);
      }
      const text = showCount ? `${baseLabel} (${count})` : baseLabel;
      label.textContent = text;
      button.title = text;
      button.setAttribute('aria-label', text);
    } else {
      if (label) label.remove();
      button.title = baseLabel;
      button.setAttribute('aria-label', baseLabel);
    }
  }

  /** Promote the commit button when any file has staged or unstaged changes. */
  _updateCommitButton(status) {
    if (!this.commitBtn) return;
    const files = Array.isArray(status?.files) ? status.files : [];
    this.commitBtn.classList.toggle('primary', files.some((f) => f && (f.untracked || f.changed || f.staged)));
  }

  _isIdentityMissing() {
    return !this.hasGitIdentity || (this.user?.name || '').trim() === '' || (this.user?.email || '').trim() === '';
  }

  /** Render branch chooser, filter and changed-file groups for one status payload. */
  render(s) {
    const hadFilterFocus = document.activeElement === this.filterInput;
    const filterSelectionStart = hadFilterFocus ? this.filterInput.selectionStart : null;
    const filterSelectionEnd = hadFilterFocus ? this.filterInput.selectionEnd : null;

    this.body.innerHTML = '';
    const header = el('div', 'git-branch-header');
    this.branchButton = document.createElement('button');
    this.branchButton.type = 'button';
    this.branchButton.className = 'git-branch-button';
    const branchTitle = this.i18n.t('git.select_branch') || 'Select branch';
    this.branchButton.title = branchTitle;
    this.branchButton.setAttribute('aria-label', branchTitle);
    this.branchButton.append(
      Icon.render('fa fa-code-fork'),
      document.createTextNode(` ${s.branch || '(detached)'}`),
      document.createTextNode(`  ↑${s.ahead} ↓${s.behind}`),
      Icon.render('fa fa-caret-down')
    );
    this.branchButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.openBranchMenu(this.branchButton);
    });
    header.appendChild(this.branchButton);
    this.body.appendChild(header);
    this.body.appendChild(this._buildFilter());

    if (s.clean) {
      const c = el('div');
      c.textContent = this.i18n.t('git.no_changes');
      c.style.color = 'var(--ide-fg-muted)';
      this.body.appendChild(c);
      this._restoreFilterFocus(hadFilterFocus, filterSelectionStart, filterSelectionEnd);
      return;
    }

    const groups = {
      staged: { label: this.i18n.t('git.staged'), items: [] },
      changed: { label: this.i18n.t('git.changes'), items: [] },
      untracked: { label: this.i18n.t('git.untracked'), items: [] },
    };
    for (const f of s.files) {
      if (f.untracked) {
        groups.untracked.items.push(f);
        continue;
      }
      // Git reports index and worktree states independently. A file can be
      // staged and still have newer unstaged changes after an export/save. Show
      // it in both groups so users can stage the new worktree delta directly
      // instead of having to unstage the older index version first.
      if (f.staged) groups.staged.items.push(f);
      if (f.changed) groups.changed.items.push(f);
    }

    const filter = this._normalizeFilter(this.filterText);
    let visibleItemCount = 0;
    for (const key of ['staged', 'changed', 'untracked']) {
      const g = groups[key];
      const items = filter ? g.items.filter((f) => this._matchesFilter(f, filter)) : g.items;
      if (items.length === 0) continue;
      visibleItemCount += items.length;
      const header = el('div', 'git-group-header');
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.style.gap = '4px';
      header.style.marginTop = '8px';
      const arrow = document.createElement('span');
      arrow.className = 'fa';
      arrow.style.cursor = 'pointer';
      arrow.style.marginRight = '4px';
      arrow.classList.add(this._collapsed[key] ? 'fa-caret-right' : 'fa-caret-down');
      arrow.addEventListener('click', () => { this._collapsed[key] = !this._collapsed[key]; this.render(s); });
      const h = document.createElement('h4');
      h.textContent = `${g.label} (${items.length})`;
      h.style.flex = '1';
      h.style.margin = '0';
      h.style.cursor = 'pointer';
      h.addEventListener('click', () => { this._collapsed[key] = !this._collapsed[key]; this.render(s); });
      header.append(arrow, h);
      const paths = items.map(f => f.path);
      if (key === 'staged') {
        header.append(this._iconBtn('fa fa-minus', this.i18n.t('git.unstage_all') || 'Unstage all', () => this._unstage(paths)));
      } else {
        header.append(this._iconBtn('fa fa-plus', this.i18n.t('git.stage_all') || 'Stage all', () => this._stage(paths)));
        header.append(key === 'untracked'
          ? this._iconBtn('fa fa-trash-o', this.i18n.t('git.delete_all_untracked') || 'Delete all untracked files', () => this._deleteUntracked(paths))
          : this._iconBtn('fa fa-undo', this.i18n.t('git.discard_all') || 'Discard all changes', () => this._discard(paths)));
      }
      this.body.appendChild(header);
      if (!this._collapsed[key]) {
        const list = el('div', 'history-detail-files git-detail-files');
        for (const f of items) list.appendChild(this._renderFile(f, key));
        this.body.appendChild(list);
      }
    }

    if (visibleItemCount === 0) {
      const empty = el('div', 'git-filter-empty', filter
        ? (this.i18n.t('git.no_matching_changes') || 'No matching changed files')
        : (this.i18n.t('git.no_changes') || 'No changes'));
      empty.style.color = 'var(--ide-fg-muted)';
      empty.style.marginTop = '8px';
      this.body.appendChild(empty);
    }
    this._restoreFilterFocus(hadFilterFocus, filterSelectionStart, filterSelectionEnd);
  }

  /** Build or reuse the quick filter input without losing its current value. */
  _buildFilter() {
    if (this.filterWrap && this.filterInput) {
      this.filterInput.value = this.filterText;
      return this.filterWrap;
    }
    const wrap = el('div', 'git-filter history-search');
    wrap.append(Icon.render('fa fa-search'));
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'git-filter-input history-search-input';
    input.placeholder = this.i18n.t('git.filter_placeholder') || 'Filter changed files…';
    input.value = this.filterText;
    input.setAttribute('aria-label', this.i18n.t('git.filter_placeholder') || 'Filter changed files…');
    input.addEventListener('input', () => {
      this.filterText = input.value || '';
      this.render(this._lastStatus || { branch: '', ahead: 0, behind: 0, clean: true, files: [] });
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.value !== '') {
        e.preventDefault();
        input.value = '';
        this.filterText = '';
        this.render(this._lastStatus || { branch: '', ahead: 0, behind: 0, clean: true, files: [] });
      }
    });
    this.filterWrap = wrap;
    this.filterInput = input;
    wrap.append(input);
    return wrap;
  }

  _restoreFilterFocus(hadFocus, selectionStart, selectionEnd) {
    if (!hadFocus || !this.filterInput) return;
    this.filterInput.focus({ preventScroll: true });
    if (selectionStart !== null && selectionEnd !== null) {
      try { this.filterInput.setSelectionRange(selectionStart, selectionEnd); } catch (e) {}
    }
  }
  _normalizeFilter(value) { return String(value || '').trim().toLowerCase(); }
  _matchesFilter(file, filter) { return !filter || String(file?.path || '').toLowerCase().includes(filter); }

  /** Render one changed-file row with inline actions and shared popup menu. */
  _renderFile(f, group) {
    const row = el('div', 'history-file-row git-file-row');
    const status = this._buildStatusDescriptor(f, group);
    const badge = el('span', `history-file-status git-file-status history-file-status-${status.kind}`, status.code);
    badge.title = status.label;
    badge.setAttribute('aria-label', status.label);
    const link = el('span', 'history-file-name git-file-name', f.path);
    link.title = this.i18n.t('git.view_diff') || 'View diff';
    link.addEventListener('click', () => this._openDiff(f.path, group === 'staged'));
    row.append(badge, link);
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); this._openMenuAt(e.clientX, e.clientY, f, group); });

    const actions = el('span', 'history-file-actions git-file-actions');
    if (group === 'staged') actions.append(this._iconBtn('fa fa-minus', this.i18n.t('git.unstage') || 'Unstage', () => this._unstage([f.path])));
    else {
      actions.append(this._iconBtn('fa fa-plus', this.i18n.t('git.stage') || 'Stage', () => this._stage([f.path])));
      actions.append((group === 'untracked' || f?.untracked)
        ? this._iconBtn('fa fa-trash-o', this.i18n.t('git.delete_untracked') || 'Delete untracked file', () => this._deleteUntracked([f.path]))
        : this._iconBtn('fa fa-undo', this.i18n.t('git.discard') || 'Discard', () => this._discard([f.path])));
    }
    actions.append(this._menuBtn(f, group));
    row.append(actions);
    return row;
  }

  /** Pick the status code from the index or worktree column for the visible group. */
  _buildStatusDescriptor(file, group) {
    if (group === 'untracked' || file?.untracked) return { code: 'U', kind: 'A', label: this.i18n.t('git.untracked') || 'Untracked' };
    const rawCode = group === 'staged' ? (file?.index || file?.worktree || 'M') : (file?.worktree || file?.index || 'M');
    const code = String(rawCode === '.' ? 'M' : rawCode).toUpperCase();
    const map = {
      M: { code: 'M', kind: 'M', label: this.i18n.t('git.changes') || 'Modified' },
      D: { code: 'D', kind: 'D', label: this.i18n.t('git.deleted') || 'Deleted' },
      A: { code: 'A', kind: 'A', label: this.i18n.t('history.status_added') || 'Added' },
      R: { code: 'R', kind: 'R', label: this.i18n.t('history.status_renamed') || 'Renamed' },
      C: { code: 'C', kind: 'C', label: this.i18n.t('history.status_copied') || 'Copied' },
      T: { code: 'T', kind: 'M', label: this.i18n.t('history.status_type_changed') || 'Type changed' },
      U: { code: 'U', kind: 'D', label: this.i18n.t('history.status_unmerged') || 'Unmerged' },
    };
    return map[code] || map.M;
  }

  _tbBtn(icon, title, onClick) { return iconButton(icon, title, onClick); }
  _iconBtn(icon, title, onClick) { return iconButton(icon, title, onClick); }

  _menuBtn(file, group) {
    const title = this.i18n.t('files.more_actions');
    const b = this._iconBtn('fa fa-ellipsis-h', title, (e) => { e?.stopPropagation?.(); this._openMenu(b, file, group); });
    return b;
  }
  _openMenu(anchor, file, group) { PopupMenu.open(anchor, this._menuItemsForFile(file, group)); }
  _openMenuAt(x, y, file, group) { PopupMenu.openAt(x, y, this._menuItemsForFile(file, group)); }

  /** Build the same row-level menu for inline and right-click entry points. */
  _menuItemsForFile(file, group) {
    const isUntracked = group === 'untracked' || file?.untracked;
    const items = [
      { icon: 'fa fa-exchange', label: this.i18n.t('git.view_diff') || 'View diff', onClick: () => this._openDiff(file.path, group === 'staged') },
      { icon: 'fa fa-file-o', label: this.i18n.t('git.open_regular_editor') || 'Open in regular editor', onClick: () => this._openFile(file.path) },
      { icon: 'fa fa-history', label: this.i18n.t('git.open_file_history') || 'Open Git history', onClick: () => this.bus?.emit?.('git:open-file-history', { path: file.path }) },
      { sep: true },
    ];
    if (group === 'staged') items.push({ icon: 'fa fa-minus', label: this.i18n.t('git.unstage') || 'Unstage', onClick: () => this._unstage([file.path]) });
    else {
      items.push({ icon: 'fa fa-plus', label: this.i18n.t('git.stage') || 'Stage', onClick: () => this._stage([file.path]) });
      items.push(isUntracked
        ? { icon: 'fa fa-trash-o', label: this.i18n.t('git.delete_untracked') || 'Delete untracked file', onClick: () => this._deleteUntracked([file.path]) }
        : { icon: 'fa fa-undo', label: this.i18n.t('git.discard') || 'Discard', onClick: () => this._discard([file.path]) });
    }
    return items;
  }

  _openFile(path) { this.onOpenFile({ path, name: path.split('/').pop() }); }

  /** Delete untracked files through the file API after confirmation. */
  async _deleteUntracked(paths) {
    const list = Array.isArray(paths) ? paths.filter(Boolean) : [paths].filter(Boolean);
    if (list.length === 0) return;
    const message = list.length === 1
      ? (this.i18n.t('files.confirm_delete', { path: list[0] }) || `Delete ${list[0]}?`)
      : (this.i18n.t('files.confirm_delete_multiple', { count: list.length }) || `Delete ${list.length} selected items?`);
    if (!window.confirm(message)) return;
    try {
      for (const path of list) await this.api.delete('/files/delete', { path });
      this.bus?.emit?.('files:changed', { action: 'delete', path: list.length === 1 ? list[0] : undefined, items: list.map((path) => ({ path })) });
      await this.refresh();
    } catch (e) { this.toasts.error(e.message); }
  }

  async _openDiff(path, staged) {
    try {
      const diffData = await this.api.get('/git/diff', { path, staged: staged ? '1' : '0' });
      this.onOpenDiff?.(path, staged, diffData);
    } catch (e) { this.toasts.error(e.message); }
  }

  async _stage(paths) { try { await this.api.post('/git/stage', { paths }); await this.refresh(); } catch (e) { this.toasts.error(e.message); } }
  async _unstage(paths) { try { await this.api.post('/git/unstage', { paths }); await this.refresh(); } catch (e) { this.toasts.error(e.message); } }

  /** Discard changed files and close matching diff tabs through the event bus. */
  async _discard(paths) {
    const message = paths.length === 1
      ? `${this.i18n.t('git.confirm_discard_single') || 'Discard local changes to'} ${paths[0]}?`
      : `${this.i18n.t('git.confirm_discard_multiple') || 'Discard local changes to'} ${paths.length} ${this.i18n.t('git.files_label') || 'files'}?`;
    if (!window.confirm(message)) return;
    try {
      await this.api.post('/git/discard', { paths });
      for (const path of paths) this.bus?.emit?.('git:file-discarded', { path });
      await this.refresh();
    } catch (e) { this.toasts.error(e.message); }
  }

  async commit(amend) {
    const message = this.msg.value.trim();
    if (!message && !amend) { this.toasts.error(this.i18n.t('git.commit_message')); return; }
    try {
      const resp = await this.api.post(amend ? '/git/amend' : '/git/commit', { message });
      this._injectConsole(resp);
      this.msg.value = '';
      this.toasts.success((amend ? 'Amended' : 'Committed') + ' ✓');
      this._emitGitOperation(amend ? 'amend' : 'commit', resp, { amend });
      this.refresh();
    } catch (e) { this._injectConsoleError(e); this.toasts.error(e.message); }
  }
  async push() {
    const publishingBranch = Boolean(this._lastStatus?.unpublished);
    try {
      const resp = await this.api.post('/git/push', {});
      this._injectConsole(resp);
      this.toasts.success((publishingBranch ? (this.i18n.t('git.branch_pushed') || 'Branch pushed') : 'Pushed') + ' ✓');
      this._emitGitOperation('push', resp, { publishingBranch });
      this.refresh();
    } catch (e) { this._injectConsoleError(e); this.toasts.error(e.message); }
  }
  async pull() {
    try {
      const resp = await this.api.post('/git/pull', {});
      this._injectConsole(resp);
      this.toasts.success('Pulled ✓');
      this._emitGitOperation('pull', resp);
      this.refresh();
    } catch (e) { this._injectConsoleError(e); this.toasts.error(e.message); }
  }

  /** Fetch and prune every remote without changing the checked-out branch. */
  async fetch() {
    if (this.fetchBtn?.disabled) return;
    if (this.fetchBtn) this.fetchBtn.disabled = true;
    try {
      const resp = await this.api.post('/git/fetch', {});
      this._injectConsole(resp);
      this.toasts.success((this.i18n.t('git.fetch_all_done') || 'Remote branches and tags updated') + ' ✓');
      this._emitGitOperation('fetch', resp);
      await this.refresh();
    } catch (e) {
      this._injectConsoleError(e);
      this.toasts.error(e.message);
    } finally {
      if (this.fetchBtn) this.fetchBtn.disabled = false;
    }
  }

  /** Open the shared branch chooser and populate it from `/git/branches`. */
  async openBranchMenu(anchor) {
    if (!anchor || this._branchMenuLoading) return;
    this._branchMenuLoading = true;
    PopupMenu.open(anchor, [{ icon: 'fa fa-refresh', label: this.i18n.t('git.loading_branches') || 'Loading branches…' }]);
    try {
      const data = await this.api.get('/git/branches');
      const current = data?.current || this._lastStatus?.branch || null;
      const items = this._branchMenuItems(data, current);
      PopupMenu.open(anchor, items.length ? items : [{ icon: 'fa fa-code-fork', label: this.i18n.t('git.no_branches') || 'No branches available' }]);
    } catch (e) {
      PopupMenu.open(anchor, [{ icon: 'fa fa-exclamation-triangle', label: e.message || (this.i18n.t('errors.generic') || 'Something went wrong.') }]);
    } finally {
      this._branchMenuLoading = false;
    }
  }

  /** Convert branch API data into grouped menu entries with branch submenus. */
  _branchMenuItems(data, current) {
    const currentSuffix = this.i18n.t('git.current_branch_suffix') || ' (current)';
    const items = [];
    const addGroup = (label, branches = [], remote = false) => {
      const list = Array.isArray(branches) ? branches.filter(Boolean) : [];
      if (list.length === 0) return;
      if (items.length > 0) items.push({ sep: true });
      items.push({ heading: true, label });
      for (const name of list) {
        const isCurrent = !remote && name === current;
        items.push({
          icon: isCurrent ? 'fa fa-bullseye' : 'fa fa-code-fork',
          label: isCurrent ? `${name}${currentSuffix}` : name,
          children: this._branchActionItems(name, { current: isCurrent, remote }),
        });
      }
    };
    addGroup(this.i18n.t('git.local_branches') || 'Local branches', data?.locals || [], false);
    addGroup(this.i18n.t('git.remote_branches') || 'Remote branches', data?.remotes || [], true);
    if (items.length > 0) items.push({ sep: true });
    items.push({ icon: 'fa fa-plus', label: this.i18n.t('git.create_branch') || 'Create branch', onClick: () => this._promptCreateBranch(current || 'HEAD') });
    return items;
  }

  /** Build the action submenu for one branch row. */
  _branchActionItems(branch, { current = false, remote = false } = {}) {
    return [
      { icon: 'fa fa-check', label: this.i18n.t('git.checkout_branch') || 'Checkout', onClick: current ? undefined : () => this.checkoutBranch(branch), disabled: current },
      { icon: 'fa fa-compress', label: this.i18n.t('git.merge_branch') || 'Merge into current branch', onClick: current ? undefined : () => this.mergeBranch(branch), disabled: current },
      { sep: true },
      { icon: 'fa fa-trash-o', label: this.i18n.t(remote ? 'git.delete_remote_branch' : 'git.delete_branch') || 'Delete branch', onClick: current ? undefined : () => this.deleteBranch(branch, remote), disabled: current },
    ];
  }

  async checkoutBranch(branch) {
    if (!branch) return;
    try {
      const resp = await this.api.post('/git/checkout', { branch });
      this._injectConsole(resp);
      this.toasts.success((this.i18n.t('git.switched_branch') || 'Switched to branch') + ` ${branch}`);
      await this.refresh();
      this.bus?.emit?.('git:branch-changed', { branch, response: resp, status: this._lastStatus });
    } catch (e) { this._injectConsoleError(e); this.toasts.error(e.message); }
  }

  async mergeBranch(branch) {
    if (!branch) return;
    if (!window.confirm(this.i18n.t('git.confirm_merge_branch', { branch }) || `Merge ${branch} into the current branch?`)) return;
    try {
      const resp = await this.api.post('/git/merge', { ref: branch });
      this._injectConsole(resp);
      this.toasts.success((this.i18n.t('git.branch_merged') || 'Merged branch') + ` ${branch} ✓`);
      await this.refresh();
      this.bus?.emit?.('git:branch-changed', { branch, response: resp, status: this._lastStatus });
    } catch (e) { this._injectConsoleError(e); this.toasts.error(e.message); }
  }

  async deleteBranch(branch, remote = false) {
    if (!branch) return;
    const key = remote ? 'git.confirm_delete_remote_branch' : 'git.confirm_delete_branch';
    const fallback = remote ? `Delete remote branch ${branch}? This removes it from the remote repository.` : `Delete branch ${branch}?`;
    if (!window.confirm(this.i18n.t(key, { branch }) || fallback)) return;
    try {
      const resp = await this.api.post('/git/delete-branch', { branch, remote });
      this._injectConsole(resp);
      this.toasts.success((this.i18n.t('git.branch_deleted') || 'Deleted branch') + ` ${branch} ✓`);
      await this.refresh();
      this.bus?.emit?.('git:branch-deleted', { branch, remote, response: resp, status: this._lastStatus });
    } catch (e) { this._injectConsoleError(e); this.toasts.error(e.message); }
  }

  async _promptCreateBranch(startPoint = 'HEAD') {
    const branch = window.prompt(this.i18n.t('git.prompt_create_branch') || 'New branch name', this._suggestBranchName(startPoint));
    if (branch === null) return;
    const trimmed = String(branch).trim();
    if (!trimmed) return;
    await this._createBranch(trimmed, startPoint);
  }
  _suggestBranchName(startPoint) { const source = String(startPoint || '').trim(); return (!source || source === 'HEAD') ? '' : source.replace(/^origin\//, '').replace(/[^A-Za-z0-9._/-]+/g, '-'); }
  async _createBranch(branch, startPoint = 'HEAD') {
    try {
      const payload = { branch, create: true };
      if (startPoint && startPoint !== 'HEAD') payload.start_point = startPoint;
      const resp = await this.api.post('/git/checkout', payload);
      this._injectConsole(resp);
      this.toasts.success((this.i18n.t('git.created_branch') || 'Created branch') + ` ${branch}`);
      await this.refresh();
      this.bus?.emit?.('git:branch-changed', { branch, response: resp, status: this._lastStatus });
      this._emitGitOperation('create-branch', resp, { branch, startPoint, status: this._lastStatus });
    } catch (e) { this._injectConsoleError(e); this.toasts.error(e.message); }
  }

  /** Broadcast completed repository-changing operations to optional panels. */
  _emitGitOperation(operation, response, extra = {}) {
    this.bus?.emit?.('git:operation-completed', { operation, response, source: 'git-panel', ...extra });
  }

  _injectConsole(resp) { const block = resp?.console; if (block && this.bus) this.bus.emit('console:inject', block); }
  _injectConsoleError(e) { const block = e?.details?.console; if (block && this.bus) this.bus.emit('console:inject', { ...block, ok: false, autoOpen: true }); }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function btn(text, onClick, title) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function iconButton(icon, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tb-btn';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.append(Icon.render(icon));
  b.addEventListener('click', (event) => { event.stopPropagation(); onClick(event); });
  return b;
}
