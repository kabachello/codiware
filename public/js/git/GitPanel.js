/** Source-control sidebar panel. */
import { Icon } from '../core/Icon.js';

export class GitPanel {
  constructor({ api, i18n, toasts, bus, onOpenDiff, onOpenHistory, onOpenFile, user = {}, hasGitIdentity = true, initialStatus = null }) {
    this.api = api;
    this.i18n = i18n;
    this.toasts = toasts;
    this.bus = bus;
    this.onOpenDiff = onOpenDiff; // Callback: (path, staged, diffData) => void
    this.onOpenHistory = typeof onOpenHistory === 'function' ? onOpenHistory : () => {};
    this.onOpenFile = typeof onOpenFile === 'function' ? onOpenFile : () => {};
    this.user = user || {};
    this.hasGitIdentity = Boolean(hasGitIdentity);
    this.filterText = '';
    this._lastStatus = initialStatus || null;
    this._contextEntry = null;
    this._branchMenuLoading = false;
    this._branchMenuCurrent = null;
    bus.on('file:saved', () => this.refresh());
  }

  mount(host) {
    this.host = host;
    host.innerHTML = '';

    // Use the same toolbar structure and classes as the explorer panel
    const toolbar = el('div');
    toolbar.className = 'panel-toolbar';
    this.pushBtn = tbBtn('fa fa-cloud-upload', this.i18n.t('git.push'), () => this.push());
    this.pullBtn = tbBtn('fa fa-cloud-download', this.i18n.t('git.pull'), () => this.pull());
    toolbar.append(
      tbBtn('fa fa-refresh', this.i18n.t('actions.refresh'), () => this.refresh()),
      this.pushBtn,
      this.pullBtn,
      tbBtn('fa fa-history', this.i18n.t('git.history'), () => this.onOpenHistory())
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

    const commitRow = el('div');
    commitRow.style.display = 'flex'; commitRow.style.gap = '4px'; commitRow.style.marginTop = '4px';
    commitRow.classList.add('panel-toolbar');
    this.commitBtn = btn(this.i18n.t('git.commit'), () => this.commit(false));
    const amendBtn = btn(this.i18n.t('git.amend'), () => this.commit(true));
    commitRow.append(this.commitBtn, amendBtn);

    this.body = el('div');
    this.body.className = 'git-status-list';
    this.filterWrap = null;
    this.filterInput = null;

    host.append(toolbar);
    if (this.identityWarning) host.append(this.identityWarning);
    host.append(this.msg, commitRow, this.body);
    // Helper for toolbar buttons (matches FileTree)
    function tbBtn(icon, title, onClick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tb-btn';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.append(Icon.render(icon));
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      return b;
    }
    this._collapsed = { staged: false, changed: false, untracked: false };
    if (this._lastStatus) {
      this.bus?.emit?.('git:status-updated', this._lastStatus);
      this._updatePushButton(this._lastStatus);
      this._updatePullButton(this._lastStatus);
      this._updateCommitButton(this._lastStatus);
      this.render(this._lastStatus);
      return;
    }
    this.refresh();
  }

  async refresh() {
    if (!this.body) return;
    this.body.textContent = '…';
    try {
      const data = await this.api.get('/git/status');
      this._applyStatus(data);
    } catch (e) {
      this.body.textContent = e.message;
    }
  }

  /**
   * Store one git-status payload, fan it out through the event bus and refresh
   * all branch/count related UI bits from that single source of truth.
   */
  _applyStatus(data) {
    this._lastStatus = data;
    this.bus?.emit?.('git:status-updated', data);
    this._updatePushButton(data);
    this._updatePullButton(data);
    this._updateCommitButton(data);
    this.render(data);
  }

  _updatePushButton(status) {
    const ahead = Number(status?.ahead || 0);
    this._updateSyncButton(this.pushBtn, this.i18n.t('git.push'), ahead);
  }

  _updatePullButton(status) {
    const behind = Number(status?.behind || 0);
    this._updateSyncButton(this.pullBtn, this.i18n.t('git.pull'), behind);
  }

  _updateSyncButton(button, baseLabel, count) {
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
      label.textContent = `${baseLabel} (${count})`;
      button.title = `${baseLabel} (${count})`;
      button.setAttribute('aria-label', `${baseLabel} (${count})`);
    } else {
      if (label) label.remove();
      button.title = baseLabel;
      button.setAttribute('aria-label', baseLabel);
    }
  }

  _updateCommitButton(status) {
    if (!this.commitBtn) return;
    const files = Array.isArray(status?.files) ? status.files : [];
    const hasSomethingToCommit = files.some((f) => f && (f.untracked || f.changed || f.staged));
    this.commitBtn.classList.toggle('primary', hasSomethingToCommit);
  }

  _isIdentityMissing() {
    const missingName = (this.user?.name || '').trim() === '';
    const missingEmail = (this.user?.email || '').trim() === '';
    return !this.hasGitIdentity || missingName || missingEmail;
  }

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
      const c = el('div'); c.textContent = this.i18n.t('git.no_changes');
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
      if (f.untracked) groups.untracked.items.push(f);
      else if (f.staged) groups.staged.items.push(f);
      else groups.changed.items.push(f);
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
      // Collapsible arrow icon
      const arrow = document.createElement('span');
      arrow.className = 'fa';
      arrow.style.cursor = 'pointer';
      arrow.style.marginRight = '4px';
      arrow.classList.add(this._collapsed[key] ? 'fa-caret-right' : 'fa-caret-down');
      arrow.addEventListener('click', () => {
        this._collapsed[key] = !this._collapsed[key];
        this.render(s);
      });
      header.appendChild(arrow);
      const h = document.createElement('h4');
      h.textContent = `${g.label} (${items.length})`;
      h.style.flex = '1';
      h.style.margin = '0';
      h.style.cursor = 'pointer';
      h.addEventListener('click', () => {
        this._collapsed[key] = !this._collapsed[key];
        this.render(s);
      });
      header.appendChild(h);
      const paths = items.map(f => f.path);
      if (key === 'staged') {
        header.appendChild(iconBtn(
          'fa fa-minus',
          this.i18n.t('git.unstage_all') || 'Unstage all',
          () => this._unstage(paths)
        ));
      } else {
        header.appendChild(iconBtn(
          'fa fa-plus',
          this.i18n.t('git.stage_all') || 'Stage all',
          () => this._stage(paths)
        ));
        if (key === 'untracked') {
          header.appendChild(iconBtn(
            'fa fa-trash-o',
            this.i18n.t('git.delete_all_untracked') || 'Delete all untracked files',
            () => this._deleteUntracked(paths)
          ));
        } else {
          header.appendChild(iconBtn(
            'fa fa-undo',
            this.i18n.t('git.discard_all') || 'Discard all changes',
            () => this._discard(paths)
          ));
        }
      }
      this.body.appendChild(header);
      if (!this._collapsed[key]) {
        const list = el('div', 'history-detail-files git-detail-files');
        for (const f of items) list.appendChild(this._renderFile(f, key));
        this.body.appendChild(list);
      }
    }

    if (filter && visibleItemCount === 0) {
      const empty = el('div', 'git-filter-empty', this.i18n.t('git.no_matching_changes') || 'No matching changed files');
      empty.style.color = 'var(--ide-fg-muted)';
      empty.style.marginTop = '8px';
      this.body.appendChild(empty);
    }

    this._restoreFilterFocus(hadFilterFocus, filterSelectionStart, filterSelectionEnd);
  }

  _buildFilter() {
    if (this.filterWrap && this.filterInput) {
      this.filterInput.value = this.filterText;
      return this.filterWrap;
    }

    const wrap = document.createElement('div');
    wrap.className = 'git-filter history-search';
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
      try {
        this.filterInput.setSelectionRange(selectionStart, selectionEnd);
      } catch (e) {
        // Ignore unsupported input selection errors.
      }
    }
  }

  _normalizeFilter(value) {
    return String(value || '').trim().toLowerCase();
  }

  _matchesFilter(file, filter) {
    if (!filter) return true;
    return String(file?.path || '').toLowerCase().includes(filter);
  }

  _renderFile(f, group) {
    const row = el('div', 'history-file-row git-file-row');
    const status = this._buildStatusDescriptor(f, group);

    const badge = document.createElement('span');
    badge.className = `history-file-status git-file-status history-file-status-${status.kind}`;
    badge.title = status.label;
    badge.setAttribute('aria-label', status.label);
    badge.textContent = status.code;
    row.append(badge);

    const link = document.createElement('span');
    link.className = 'history-file-name git-file-name';
    link.textContent = f.path;
    link.title = this.i18n.t('git.view_diff') || 'View diff';
    link.addEventListener('click', () => this._openDiff(f.path, group === 'staged'));
    row.append(link);

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._openMenuAt(e.clientX, e.clientY, f, group);
    });

    const actions = document.createElement('span');
    actions.className = 'history-file-actions git-file-actions';

    if (group === 'staged') {
      actions.append(this._iconBtn('fa fa-minus', this.i18n.t('git.unstage') || 'Unstage', () => this._unstage([f.path])));
    } else {
      actions.append(this._iconBtn('fa fa-plus', this.i18n.t('git.stage') || 'Stage', () => this._stage([f.path])));
      if (group === 'untracked' || f?.untracked) {
        actions.append(this._iconBtn('fa fa-trash-o', this.i18n.t('git.delete_untracked') || 'Delete untracked file', () => this._deleteUntracked([f.path])));
      } else {
        actions.append(this._iconBtn('fa fa-undo', this.i18n.t('git.discard') || 'Discard', () => this._discard([f.path])));
      }
    }

    actions.append(this._menuBtn(f, group));
    row.append(actions);
    return row;
  }

  _buildStatusDescriptor(file, group) {
    if (group === 'untracked' || file?.untracked) {
      return { code: 'U', kind: 'A', label: this.i18n.t('git.untracked') || 'Untracked' };
    }
    const code = String(file?.worktree || file?.index || 'M').toUpperCase();
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

  _iconBtn(icon, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tb-btn';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.append(Icon.render(icon));
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  _menuBtn(file, group) {
    const title = this.i18n.t('files.more_actions');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tb-btn';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.append(Icon.render('fa fa-ellipsis-h'));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      this._openMenu(b, file, group);
    });
    return b;
  }

  _openMenu(anchor, file, group) {
    GitPopupMenu.open(anchor, this._menuItemsForFile(file, group));
  }

  _openMenuAt(x, y, file, group) {
    GitPopupMenu.openAt(x, y, this._menuItemsForFile(file, group));
  }

  _menuItemsForFile(file, group) {
    const isUntracked = group === 'untracked' || file?.untracked;
    const items = [
      { icon: 'fa fa-exchange', label: this.i18n.t('git.view_diff') || 'View diff', onClick: () => this._openDiff(file.path, group === 'staged') },
      { icon: 'fa fa-file-o', label: this.i18n.t('git.open_regular_editor') || 'Open in regular editor', onClick: () => this._openFile(file.path) },
    ];

    if (group === 'staged') {
      items.push({ sep: true });
      items.push({ icon: 'fa fa-minus', label: this.i18n.t('git.unstage') || 'Unstage', onClick: () => this._unstage([file.path]) });
    } else {
      items.push({ sep: true });
      items.push({ icon: 'fa fa-plus', label: this.i18n.t('git.stage') || 'Stage', onClick: () => this._stage([file.path]) });
      if (isUntracked) {
        items.push({ icon: 'fa fa-trash-o', label: this.i18n.t('git.delete_untracked') || 'Delete untracked file', onClick: () => this._deleteUntracked([file.path]) });
      } else {
        items.push({ icon: 'fa fa-undo', label: this.i18n.t('git.discard') || 'Discard', onClick: () => this._discard([file.path]) });
      }
    }

    return items;
  }

  _openFile(path) {
    this.onOpenFile({ path, name: path.split('/').pop() });
  }

  /**
   * Delete one or more untracked files through the regular file API.
   *
   * Git cannot discard untracked files with `git checkout --`, so untracked
   * rows expose a delete action instead. Every deleted path is announced over
   * the shared `files:changed` bus event so the explorer and open tabs can
   * refresh just like after a delete from the file tree.
   */
  async _deleteUntracked(paths) {
    const list = Array.isArray(paths) ? paths.filter(Boolean) : [paths].filter(Boolean);
    if (list.length === 0) return;
    const message = list.length === 1
      ? (this.i18n.t('files.confirm_delete', { path: list[0] }) || `Delete ${list[0]}?`)
      : (this.i18n.t('files.confirm_delete_multiple', { count: list.length }) || `Delete ${list.length} selected items?`);
    if (!window.confirm(message)) return;
    try {
      for (const path of list) {
        await this.api.delete('/files/delete', { path });
      }
      this.bus?.emit?.('files:changed', {
        action: 'delete',
        path: list.length === 1 ? list[0] : undefined,
        items: list.map((path) => ({ path })),
      });
      this.refresh();
    } catch (e) {
      this.toasts.error(e.message);
    }
  }

  async _openDiff(path, staged) {
    try {
      const diffData = await this.api.get('/git/diff', { path, staged: staged ? '1' : '0' });
      if (this.onOpenDiff) {
        this.onOpenDiff(path, staged, diffData);
      }
    } catch (e) {
      this.toasts.error(e.message);
    }
  }

  async _stage(paths) { try { await this.api.post('/git/stage', { paths }); this.refresh(); } catch (e) { this.toasts.error(e.message); } }
  async _unstage(paths) { try { await this.api.post('/git/unstage', { paths }); this.refresh(); } catch (e) { this.toasts.error(e.message); } }
  async _discard(paths) {
    const message = paths.length === 1
      ? `${this.i18n.t('git.confirm_discard_single') || 'Discard local changes to'} ${paths[0]}?`
      : `${this.i18n.t('git.confirm_discard_multiple') || 'Discard local changes to'} ${paths.length} ${this.i18n.t('git.files_label') || 'files'}?`;
    if (!window.confirm(message)) return;
    try {
      await this.api.post('/git/discard', { paths });
      for (const path of paths) {
        this.bus?.emit?.('git:file-discarded', { path });
      }
      this.refresh();
    }
    catch (e) { this.toasts.error(e.message); }
  }

  async commit(amend) {
    const message = this.msg.value.trim();
    if (!message && !amend) { this.toasts.error(this.i18n.t('git.commit_message')); return; }
    try {
      const resp = await this.api.post(amend ? '/git/amend' : '/git/commit', { message });
      this._injectConsole(resp);
      this.msg.value = '';
      this.toasts.success((amend ? 'Amended' : 'Committed') + ' ✓');
      this.refresh();
    } catch (e) { this._injectConsoleError(e); this.toasts.error(e.message); }
  }

  async push() {
    try { const resp = await this.api.post('/git/push', {}); this._injectConsole(resp); this.toasts.success('Pushed ✓'); this.refresh(); }
    catch (e) { this._injectConsoleError(e); this.toasts.error(e.message); }
  }

  async pull() {
    try { const resp = await this.api.post('/git/pull', {}); this._injectConsole(resp); this.toasts.success('Pulled ✓'); this.refresh(); }
    catch (e) { this._injectConsoleError(e); this.toasts.error(e.message); }
  }

  /**
   * Open the branch chooser anchored to one of the branch-name buttons and fill
   * it with local and remote refs fetched on demand from the Git API.
   */
  async openBranchMenu(anchor) {
    if (!anchor || this._branchMenuLoading) return;
    this._branchMenuCurrent = anchor;
    this._branchMenuLoading = true;
    const loadingLabel = this.i18n.t('git.loading_branches') || 'Loading branches…';
    GitPopupMenu.open(anchor, [{ icon: 'fa fa-refresh', label: loadingLabel }]);
    try {
      const data = await this.api.get('/git/branches');
      const current = data?.current || this._lastStatus?.branch || null;
      const items = this._branchMenuItems(data, current);
      GitPopupMenu.open(anchor, items.length ? items : [{ icon: 'fa fa-code-fork', label: this.i18n.t('git.no_branches') || 'No branches available' }]);
    } catch (e) {
      GitPopupMenu.open(anchor, [{ icon: 'fa fa-exclamation-triangle', label: e.message || (this.i18n.t('errors.generic') || 'Something went wrong.') }]);
    } finally {
      this._branchMenuLoading = false;
    }
  }

  /**
   * Convert the `/git/branches` response into grouped popup-menu entries while
   * marking the currently checked out branch with the shared "current" suffix.
   */
  _branchMenuItems(data, current) {
    const currentSuffix = this.i18n.t('git.current_branch_suffix') || ' (current)';
    const items = [];
    const addCreateBranchAction = () => {
      if (items.length > 0) items.push({ sep: true });
      items.push({
        icon: 'fa fa-plus',
        label: this.i18n.t('git.create_branch') || 'Create branch',
        onClick: () => this._promptCreateBranch(current || 'HEAD'),
      });
    };
    const addGroup = (label, branches = []) => {
      const list = Array.isArray(branches) ? branches.filter(Boolean) : [];
      if (list.length === 0) return;
      if (items.length > 0) items.push({ sep: true });
      items.push({ icon: 'fa fa-tag', label, disabled: true });
      for (const name of list) {
        const isCurrent = name === current;
        items.push({
          icon: isCurrent ? 'fa fa-check' : 'fa fa-code-fork',
          label: isCurrent ? `${name}${currentSuffix}` : name,
          onClick: isCurrent ? undefined : () => this.checkoutBranch(name),
          disabled: isCurrent,
        });
      }
    };

    addGroup(this.i18n.t('git.local_branches') || 'Local branches', data?.locals || []);
    addGroup(this.i18n.t('git.remote_branches') || 'Remote branches', data?.remotes || []);
    addCreateBranchAction();
    return items;
  }

  /**
   * Check out one branch selected from the dropdown, surface the captured git
   * output in the console and refresh the shared status afterwards.
   */
  async checkoutBranch(branch) {
    if (!branch) return;
    try {
      const resp = await this.api.post('/git/checkout', { branch });
      this._injectConsole(resp);
      this.toasts.success((this.i18n.t('git.switched_branch') || 'Switched to branch') + ` ${branch}`);
      await this.refresh();
      this.bus?.emit?.('git:branch-changed', { branch, response: resp, status: this._lastStatus });
    } catch (e) {
      this._injectConsoleError(e);
      this.toasts.error(e.message);
    }
  }

  /**
   * Ask for a new branch name and create it from the selected start point. The
   * new branch is checked out immediately because the back end uses
   * `git checkout -b`, mirroring the workflow users know from desktop Git UIs.
   */
  async _promptCreateBranch(startPoint = 'HEAD') {
    const branch = window.prompt(
      this.i18n.t('git.prompt_create_branch') || 'New branch name',
      this._suggestBranchName(startPoint)
    );
    if (branch === null) return;
    const trimmed = String(branch).trim();
    if (!trimmed) return;
    await this._createBranch(trimmed, startPoint);
  }

  _suggestBranchName(startPoint) {
    const source = String(startPoint || '').trim();
    if (!source || source === 'HEAD') return '';
    return source.replace(/^origin\//, '').replace(/[^A-Za-z0-9._/-]+/g, '-');
  }

  async _createBranch(branch, startPoint = 'HEAD') {
    try {
      const payload = { branch, create: true };
      if (startPoint && startPoint !== 'HEAD') payload.start_point = startPoint;
      const resp = await this.api.post('/git/checkout', payload);
      this._injectConsole(resp);
      this.toasts.success((this.i18n.t('git.created_branch') || 'Created branch') + ` ${branch}`);
      await this.refresh();
      this.bus?.emit?.('git:branch-changed', { branch, response: resp, status: this._lastStatus });
    } catch (e) {
      this._injectConsoleError(e);
      this.toasts.error(e.message);
    }
  }

  /** Surface the CLI output embedded in a structured git response in the console. */
  _injectConsole(resp) {
    const block = resp?.console;
    if (block && this.bus) this.bus.emit('console:inject', block);
  }

  /** Surface the CLI output carried by a failed git request and open the console. */
  _injectConsoleError(e) {
    const block = e?.details?.console;
    if (block && this.bus) this.bus.emit('console:inject', { ...block, ok: false, autoOpen: true });
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(text, onClick, title) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = text;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
function iconBtn(icon, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button'; b.title = title;
  b.setAttribute('aria-label', title);
  b.append(Icon.render(icon));
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Shared popup-menu controller that supports one nested submenu chain without
 * closing the parent menu. Branch and file menus therefore keep behaving like
 * one connected menu tree when the user moves the pointer into a submenu.
 */
const GitPopupMenu = createPopupMenuController();

/**
 * Build a popup-menu controller with support for anchored top-level menus and
 * hover/click driven submenus that stay open while the interaction remains in
 * the same menu tree.
 */
function createPopupMenuController() {
  return {
    stack: [],
    outsideHandler: null,
    keyHandler: null,
    resizeHandler: null,
    scrollHandler: null,

    open(anchor, items) {
      const rect = anchor.getBoundingClientRect();
      this.openAt(rect.right, rect.bottom + 2, items, { flipYFrom: rect.top - 2 });
    },

    openAt(x, y, items, options = {}) {
      this.closeAll();
      this._ensureGlobalListeners();
      this._openLevel({ x, y, items, level: 0, parentButton: null, options });
    },

    closeAll() {
      while (this.stack.length) {
        const entry = this.stack.pop();
        entry.menu.remove();
      }
      this._removeGlobalListeners();
    },

    closeFrom(level) {
      while (this.stack.length > level) {
        const entry = this.stack.pop();
        entry.menu.remove();
      }
      if (this.stack.length === 0) this._removeGlobalListeners();
    },

    _openLevel({ x, y, items, level, parentButton, options = {} }) {
      this.closeFrom(level);
      const menu = this._renderMenu(items, level);
      document.body.appendChild(menu);
      const pos = this._positionMenu(menu, x, y, options);
      menu.style.left = pos.left + 'px';
      menu.style.top = pos.top + 'px';
      this.stack.push({ menu, level, parentButton });
    },

    _renderMenu(items, level) {
      const menu = document.createElement('div');
      menu.className = 'codiware-popup-menu';
      menu.setAttribute('role', 'menu');
      menu.dataset.menuLevel = String(level);

      menu.addEventListener('pointerleave', () => {
        this._scheduleHoverSync();
      });

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
        if (item.disabled) btn.classList.add('is-disabled');
        btn.disabled = Boolean(item.disabled);
        btn.setAttribute('role', 'menuitem');
        btn.append(Icon.render(item.icon || ''));
        const label = document.createElement('span');
        label.textContent = item.label;
        btn.appendChild(label);

        if (Array.isArray(item.children) && item.children.length > 0) {
          btn.classList.add('has-children');
          btn.appendChild(Icon.render('fa fa-caret-right'));
          btn.addEventListener('pointerenter', () => {
            if (item.disabled) return;
            this._openChildMenu(btn, item.children, level);
          });
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (item.disabled) return;
            this._openChildMenu(btn, item.children, level);
          });
        } else {
          btn.addEventListener('pointerenter', () => {
            this.closeFrom(level + 1);
          });
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (item.disabled) return;
            this.closeAll();
            try { item.onClick?.(); } catch (err) { console.error(err); }
          });
        }

        menu.appendChild(btn);
      }

      return menu;
    },

    _openChildMenu(button, items, parentLevel) {
      const rect = button.getBoundingClientRect();
      this._openLevel({
        x: rect.right + 2,
        y: rect.top,
        items,
        level: parentLevel + 1,
        parentButton: button,
        options: { flipYFrom: rect.bottom },
      });
    },

    _positionMenu(menu, x, y, options) {
      const mw = menu.offsetWidth;
      const mh = menu.offsetHeight;
      let left = Math.min(x, window.innerWidth - mw - 4);
      if (left < 4) left = 4;
      let top = y;
      if (top + mh > window.innerHeight - 4) {
        const flipYFrom = typeof options.flipYFrom === 'number' ? options.flipYFrom : (y - 4);
        top = Math.max(4, flipYFrom - mh);
      }
      return { left, top };
    },

    _ensureGlobalListeners() {
      if (!this.outsideHandler) {
        this.outsideHandler = (e) => {
          if (!this._containsNode(e.target)) this.closeAll();
        };
        document.addEventListener('mousedown', this.outsideHandler);
      }
      if (!this.keyHandler) {
        this.keyHandler = (e) => { if (e.key === 'Escape') this.closeAll(); };
        document.addEventListener('keydown', this.keyHandler);
      }
      if (!this.resizeHandler) {
        this.resizeHandler = () => this.closeAll();
        window.addEventListener('resize', this.resizeHandler);
      }
      if (!this.scrollHandler) {
        this.scrollHandler = () => this.closeAll();
        window.addEventListener('scroll', this.scrollHandler, true);
      }
    },

    _removeGlobalListeners() {
      if (this.outsideHandler) {
        document.removeEventListener('mousedown', this.outsideHandler);
        this.outsideHandler = null;
      }
      if (this.keyHandler) {
        document.removeEventListener('keydown', this.keyHandler);
        this.keyHandler = null;
      }
      if (this.resizeHandler) {
        window.removeEventListener('resize', this.resizeHandler);
        this.resizeHandler = null;
      }
      if (this.scrollHandler) {
        window.removeEventListener('scroll', this.scrollHandler, true);
        this.scrollHandler = null;
      }
    },

    _containsNode(node) {
      return this.stack.some((entry) => entry.menu.contains(node) || entry.parentButton?.contains?.(node));
    },

    _scheduleHoverSync() {
      requestAnimationFrame(() => this._syncMenusToHover());
    },

    _syncMenusToHover() {
      if (this.stack.length <= 1) {
        const root = this.stack[0];
        if (!root) return;
        const hovered = Array.from(document.querySelectorAll(':hover'));
        const overRoot = hovered.some((el) => root.menu.contains(el));
        if (!overRoot) this.closeAll();
        return;
      }
      const hovered = Array.from(document.querySelectorAll(':hover'));
      let keepDepth = 1;
      for (let i = 1; i < this.stack.length; i++) {
        const entry = this.stack[i];
        const parentButton = entry.parentButton;
        const overParent = parentButton ? hovered.includes(parentButton) : false;
        const overMenu = hovered.some((el) => entry.menu.contains(el));
        if (overParent || overMenu) {
          keepDepth = i + 1;
        } else {
          break;
        }
      }
      const root = this.stack[0];
      const overRoot = root ? hovered.some((el) => root.menu.contains(el)) : false;
      if (!overRoot && keepDepth <= 1) {
        this.closeAll();
        return;
      }
      this.closeFrom(keepDepth);
    },
  };
}
