/** Source-control sidebar panel. */
import { Icon } from '../core/Icon.js';

export class GitPanel {
  constructor({ api, i18n, toasts, bus, onOpenDiff, onOpenHistory, onOpenFile, user = {}, hasGitIdentity = true }) {
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
    this._lastStatus = null;
    this._contextEntry = null;
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
    this.refresh();
  }

  async refresh() {
    if (!this.body) return;
    this.body.textContent = '…';
    try {
      const data = await this.api.get('/git/status');
      this._lastStatus = data;
      this.bus?.emit?.('git:status-updated', data);
      this._updatePushButton(data);
      this._updatePullButton(data);
      this._updateCommitButton(data);
      this.render(data);
    } catch (e) {
      this.body.textContent = e.message;
    }
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
    const header = el('div');
    header.textContent = `${this.i18n.t('git.branch')}: ${s.branch || '(detached)'}  ↑${s.ahead} ↓${s.behind}`;
    header.style.margin = '6px 0';
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
        header.appendChild(iconBtn(
          'fa fa-undo',
          key === 'untracked'
            ? (this.i18n.t('git.discard_all_untracked') || 'Discard all untracked files')
            : (this.i18n.t('git.discard_all') || 'Discard all changes'),
          () => this._discard(paths)
        ));
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
    badge.append(Icon.render(status.icon));
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
      actions.append(this._iconBtn('fa fa-undo', this.i18n.t('git.discard') || 'Discard', () => this._discard([f.path])));
    }

    actions.append(this._menuBtn(f, group));
    row.append(actions);
    return row;
  }

  _buildStatusDescriptor(file, group) {
    if (group === 'untracked' || file?.untracked) {
      return { kind: 'A', icon: 'fa fa-file-o', label: this.i18n.t('git.untracked') || 'Untracked' };
    }
    const code = String(file?.worktree || file?.index || 'M').toUpperCase();
    const map = {
      M: { kind: 'M', icon: 'fa fa-pencil', label: this.i18n.t('git.changes') || 'Modified' },
      D: { kind: 'D', icon: 'fa fa-trash-o', label: this.i18n.t('git.deleted') || 'Deleted' },
      A: { kind: 'A', icon: 'fa fa-plus', label: this.i18n.t('history.status_added') || 'Added' },
      R: { kind: 'R', icon: 'fa fa-random', label: this.i18n.t('history.status_renamed') || 'Renamed' },
      C: { kind: 'C', icon: 'fa fa-clone', label: this.i18n.t('history.status_copied') || 'Copied' },
      T: { kind: 'M', icon: 'fa fa-exchange', label: this.i18n.t('history.status_type_changed') || 'Type changed' },
      U: { kind: 'D', icon: 'fa fa-exclamation-triangle', label: this.i18n.t('history.status_unmerged') || 'Unmerged' },
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
      items.push({ icon: 'fa fa-undo', label: this.i18n.t('git.discard') || 'Discard', onClick: () => this._discard([file.path]) });
      if (group === 'untracked' || file?.untracked) {
        items.push({ icon: 'fa fa-trash-o', label: this.i18n.t('actions.delete') || 'Delete', onClick: () => this._deleteUntracked(file.path) });
      }
    }

    return items;
  }

  _openFile(path) {
    this.onOpenFile({ path, name: path.split('/').pop() });
  }

  async _deleteUntracked(path) {
    const message = this.i18n.t('files.confirm_delete', { path }) || `Delete ${path}?`;
    if (!window.confirm(message)) return;
    try {
      await this.api.delete('/files/delete', { path });
      this.bus?.emit?.('files:changed', { action: 'delete', path });
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

const GitPopupMenu = {
  current: null,

  open(anchor, items) {
    const rect = anchor.getBoundingClientRect();
    GitPopupMenu.openAt(rect.right, rect.bottom + 2, items, { flipYFrom: rect.top - 2 });
  },

  openAt(x, y, items, options = {}) {
    GitPopupMenu.close();
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
        GitPopupMenu.close();
        try { item.onClick?.(); } catch (err) { console.error(err); }
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);

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
      if (!menu.contains(e.target)) GitPopupMenu.close();
    };
    const onKey = (e) => { if (e.key === 'Escape') GitPopupMenu.close(); };
    const onScroll = () => GitPopupMenu.close();
    setTimeout(() => document.addEventListener('mousedown', outside), 0);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);

    GitPopupMenu.current = {
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
    const c = GitPopupMenu.current;
    if (!c) return;
    GitPopupMenu.current = null;
    c.cleanup();
    c.menu.remove();
  },
};
