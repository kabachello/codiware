/** Source-control sidebar panel. */
import { Icon } from '../core/Icon.js';

export class GitPanel {
  constructor({ api, i18n, toasts, bus, onOpenDiff }) {
    this.api = api;
    this.i18n = i18n;
    this.toasts = toasts;
    this.bus = bus;
    this.onOpenDiff = onOpenDiff; // Callback: (path, staged, diffData) => void
    bus.on('file:saved', () => this.refresh());
  }

  mount(host) {
    this.host = host;
    host.innerHTML = '';
    host.classList.add('panel-section');

    const toolbar = el('div');
    toolbar.style.display = 'flex'; toolbar.style.gap = '4px';
    const refresh = iconBtn('fa fa-refresh', this.i18n.t('actions.refresh'), () => this.refresh());
    const push = iconBtn('fa fa-cloud-upload', this.i18n.t('git.push'), () => this.push());
    toolbar.append(refresh, push);

    this.msg = document.createElement('textarea');
    this.msg.placeholder = this.i18n.t('git.commit_message');
    this.msg.rows = 2;
    this.msg.style.width = '100%';

    const commitRow = el('div');
    commitRow.style.display = 'flex'; commitRow.style.gap = '4px'; commitRow.style.marginTop = '4px';
    const commitBtn = btn(this.i18n.t('git.commit'), () => this.commit(false));
    commitBtn.classList.add('primary');
    const amendBtn = btn(this.i18n.t('git.amend'), () => this.commit(true));
    commitRow.append(commitBtn, amendBtn);

    this.body = el('div');

    host.append(toolbar, this.msg, commitRow, this.body);
    this.refresh();
  }

  async refresh() {
    if (!this.body) return;
    this.body.textContent = '…';
    try {
      const data = await this.api.get('/git/status');
      this.render(data);
    } catch (e) {
      this.body.textContent = e.message;
    }
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
      const h = document.createElement('h4');
      h.textContent = `${g.label} (${g.items.length})`;
      h.style.flex = '1';
      h.style.margin = '0';
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
      for (const f of g.items) this.body.appendChild(this._renderFile(f, key));
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
      await this.api.post(amend ? '/git/amend' : '/git/commit', { message });
      this.msg.value = '';
      this.toasts.success((amend ? 'Amended' : 'Committed') + ' ✓');
      this.refresh();
    } catch (e) { this.toasts.error(e.message); }
  }

  async push() {
    try { await this.api.post('/git/push', {}); this.toasts.success('Pushed ✓'); this.refresh(); }
    catch (e) { this.toasts.error(e.message); }
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
