/** Source-control sidebar panel. */
import { Icon } from '../core/Icon.js';

export class GitPanel {
  constructor({ api, i18n, toasts, bus, onOpenDiff, user = {}, hasGitIdentity = true }) {
    this.api = api;
    this.i18n = i18n;
    this.toasts = toasts;
    this.bus = bus;
    this.onOpenDiff = onOpenDiff; // Callback: (path, staged, diffData) => void
    this.user = user || {};
    this.hasGitIdentity = Boolean(hasGitIdentity);
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
      this.pullBtn
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
    this.body.innerHTML = '';
    const header = el('div');
    header.textContent = `${this.i18n.t('git.branch')}: ${s.branch || '(detached)'}  ↑${s.ahead} ↓${s.behind}`;
    header.style.margin = '6px 0';
    this.body.appendChild(header);

    if (s.clean) {
      const c = el('div'); c.textContent = this.i18n.t('git.no_changes');
      c.style.color = 'var(--ide-fg-muted)';
      this.body.appendChild(c);
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
    for (const key of ['staged', 'changed', 'untracked']) {
      const g = groups[key];
      if (g.items.length === 0) continue;
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
      h.textContent = `${g.label} (${g.items.length})`;
      h.style.flex = '1';
      h.style.margin = '0';
      h.style.cursor = 'pointer';
      h.addEventListener('click', () => {
        this._collapsed[key] = !this._collapsed[key];
        this.render(s);
      });
      header.appendChild(h);
      const paths = g.items.map(f => f.path);
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
      }
      this.body.appendChild(header);
      if (!this._collapsed[key]) {
        for (const f of g.items) this.body.appendChild(this._renderFile(f, key));
      }
    }
  }

  _renderFile(f, group) {
    const row = el('div');
    row.style.display = 'flex'; row.style.gap = '4px'; row.style.alignItems = 'center';
    row.style.padding = '2px 0';
    const label = el('span');
    label.className = 'git-file-label';
    label.textContent = `${f.index}${f.worktree}  ${f.path}`;
    label.style.fontFamily = 'var(--ide-font-mono)';
    label.style.fontSize = 'var(--ide-fs-sm)';
    label.style.flex = '1';
    label.style.overflow = 'hidden';
    label.style.textOverflow = 'ellipsis';
    label.style.cursor = 'pointer';
    label.title = this.i18n.t('git.view_diff') || 'View diff';
    row.appendChild(label);

    // Click on the filename to open the diff view
    const staged = group === 'staged';
    label.addEventListener('click', () => this._openDiff(f.path, staged));

    if (group === 'staged') {
      row.appendChild(iconBtn('fa fa-minus', this.i18n.t('git.unstage') || 'Unstage', () => this._unstage([f.path])));
    } else {
      row.appendChild(iconBtn('fa fa-plus', this.i18n.t('git.stage') || 'Stage', () => this._stage([f.path])));
      if (group !== 'untracked') {
        row.appendChild(iconBtn('fa fa-undo', this.i18n.t('git.discard') || 'Discard', () => this._discard([f.path])));
      }
    }
    return row;
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
    if (!window.confirm('Discard local changes to ' + paths.join(', ') + '?')) return;
    try { await this.api.post('/git/discard', { paths }); this.refresh(); }
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
