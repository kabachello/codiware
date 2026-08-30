/** Git history (commit graph) bottom panel. */
import { Icon } from '../core/Icon.js';
import { PopupMenu } from '../core/PopupMenu.js';
import { attachSplitter } from '../layout/Splitter.js';

const LANE_W = 14;
const ROW_H = 28;
const DOT_R = 4;
const GRAPH_COLORS = ['#2563eb', '#16a34a', '#db2777', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#65a30d', '#c026d3', '#0d9488', '#ea580c', '#4f46e5'];
const HISTORY_LIMIT = 200;
const AUTO_REFRESH_OPERATIONS = new Set(['commit', 'amend', 'push', 'pull', 'fetch', 'create-branch', 'reset']);

export class HistoryPanel {
  constructor({ api, i18n, toasts, bus, onOpenDiff, onOpenFile }) {
    this.api = api;
    this.i18n = i18n;
    this.toasts = toasts;
    this.bus = bus;
    this.onOpenDiff = typeof onOpenDiff === 'function' ? onOpenDiff : () => {};
    this.onOpenFile = typeof onOpenFile === 'function' ? onOpenFile : () => {};
    this.commits = [];
    this.selected = null;
    this._loaded = false;
    this.search = '';
    this._searchTimer = null;
    this.graphWidth = 60;
    this._refreshPromise = null;
    this.bus?.on?.('git:operation-completed', (payload) => this.refreshAfterGitOperation(payload));
  }

  _t(key, fallback) {
    const v = this.i18n?.t?.(key);
    return v && v !== key ? v : fallback;
  }

  /** Build the split history view and lazily load commits on first mount. */
  mount(host) {
    this.host = host;
    host.innerHTML = '';
    host.classList.add('history-panel');
    const toolbar = document.createElement('div');
    toolbar.className = 'panel-toolbar';
    toolbar.append(this._tbBtn('fa fa-refresh', this._t('actions.refresh', 'Refresh'), () => this.refresh()), this._buildSearch());
    const split = document.createElement('div');
    split.className = 'history-split';
    this.graphPane = document.createElement('div');
    this.graphPane.className = 'history-graph-pane';
    this.graphPane.style.flex = `0 0 ${this.graphWidth}%`;
    this.splitter = document.createElement('div');
    this.splitter.className = 'history-splitter';
    this.detailsPane = document.createElement('div');
    this.detailsPane.className = 'history-details-pane';
    this._renderEmptyDetails();
    split.append(this.graphPane, this.splitter, this.detailsPane);
    host.append(toolbar, split);
    this.splitEl = split;
    attachSplitter(this.splitter, {
      orientation: 'vertical',
      onResize: {
        getSize: () => (this.graphWidth / 100) * (this.splitEl?.clientWidth || 1),
        apply: (px) => {
          const pct = Math.max(15, Math.min(85, (px / (this.splitEl?.clientWidth || 1)) * 100));
          this.graphWidth = pct;
          this.graphPane.style.flex = `0 0 ${pct}%`;
        }
      }
    });
    if (!this._loaded) this.refresh();
    else this._renderGraph();
  }

  /** Build the server-side history search field. */
  _buildSearch() {
    const wrap = document.createElement('div');
    wrap.className = 'history-search';
    wrap.append(Icon.render('fa fa-search'));
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'history-search-input';
    input.placeholder = this._t('history.search_placeholder', 'Search history…');
    input.value = this.search;
    input.setAttribute('aria-label', input.placeholder);
    input.addEventListener('input', () => {
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => this._applySearch(input.value), 250);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(this._searchTimer); this._applySearch(input.value); }
      else if (e.key === 'Escape' && input.value !== '') { e.preventDefault(); input.value = ''; this._applySearch(''); }
    });
    this.searchInput = input;
    wrap.append(input);
    return wrap;
  }

  _applySearch(value) {
    const v = (value || '').trim();
    if (v === this.search) return;
    this.search = v;
    this.refresh();
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

  /** Refresh an already mounted or previously opened history panel after Git changed repository history. */
  async refreshAfterGitOperation(payload) {
    if (!this._matchesAutoRefreshOperation(payload?.operation)) return;
    if (!this._loaded && !this.host) return;
    await this.refresh();
  }

  /** Check whether one Git operation is expected to change visible history data. */
  _matchesAutoRefreshOperation(operation) {
    return AUTO_REFRESH_OPERATIONS.has(String(operation || '').toLowerCase());
  }

  /** Fetch commit history, recompute lanes and render the graph pane. */
  async refresh() {
    if (!this.graphPane) return;
    if (this._refreshPromise) return this._refreshPromise;
    this.graphPane.textContent = '…';
    this._refreshPromise = (async () => {
      try {
        const params = { limit: HISTORY_LIMIT };
        if (this.search) params.search = this.search;
        const data = await this.api.get('/git/history', params);
        this.commits = Array.isArray(data?.commits) ? data.commits : [];
        this._loaded = true;
        this._graph = computeGraph(this.commits);
        this._renderGraph();
        if (this.selected && this.commits.some((commit) => commit.hash === this.selected)) {
          await this._loadDetails(this.selected);
        } else if (this.selected) {
          this.selected = null;
          this._renderEmptyDetails();
        }
      } catch (e) {
        this.graphPane.textContent = e.message;
      } finally {
        this._refreshPromise = null;
      }
    })();
    return this._refreshPromise;
  }

  /** Render the commit rows and attach shared PopupMenu context menus. */
  _renderGraph() {
    const pane = this.graphPane;
    pane.innerHTML = '';
    if (!this.commits.length) {
      pane.classList.add('is-empty');
      pane.textContent = this.search ? this._t('history.no_matches', 'No matching commits') : this._t('history.empty', 'No commits');
      return;
    }
    pane.classList.remove('is-empty');
    const graph = this._graph || computeGraph(this.commits);
    const graphWidth = Math.max(1, graph.cols) * LANE_W;
    const showLanes = !this.search;
    const table = document.createElement('div');
    table.className = 'history-table';
    table.setAttribute('role', 'list');
    for (const row of graph.rows) {
      const c = row.commit;
      const tr = document.createElement('div');
      tr.className = 'history-row';
      tr.setAttribute('role', 'listitem');
      tr.tabIndex = 0;
      tr.dataset.hash = c.hash;
      const graphCell = document.createElement('div');
      graphCell.className = 'history-graph-cell';
      if (showLanes) {
        graphCell.style.width = graphWidth + 'px';
        graphCell.style.minWidth = graphWidth + 'px';
        graphCell.innerHTML = renderGraphSvg(row, graph.cols);
      } else graphCell.classList.add('is-hidden');
      const subjectCell = document.createElement('div');
      subjectCell.className = 'history-subject';
      for (const ref of c.refs || []) subjectCell.append(this._renderRefChip(ref));
      const subjectText = document.createElement('span');
      subjectText.className = 'history-subject-text';
      subjectText.textContent = c.subject || '';
      subjectText.title = c.subject || '';
      subjectCell.append(subjectText);
      const authorCell = el('div', 'history-author', c.author || c.committer || '');
      authorCell.title = authorCell.textContent;
      const dateCell = el('div', 'history-date', formatDate(c.commit_date || c.date, false));
      dateCell.title = formatDate(c.commit_date || c.date, true);
      const hashCell = el('div', 'history-hash', (c.hash || '').slice(0, 8));
      tr.append(graphCell, subjectCell, authorCell, dateCell, hashCell);
      tr.addEventListener('click', () => this._select(c.hash, tr));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._select(c.hash, tr); } });
      tr.addEventListener('contextmenu', (e) => { e.preventDefault(); this._openCommitMenuAt(e.clientX, e.clientY, c); });
      table.append(tr);
    }
    pane.append(table);
    if (this.selected) pane.querySelector(`.history-row[data-hash="${cssEscape(this.selected)}"]`)?.classList.add('is-selected');
  }

  _renderRefChip(ref) {
    const chip = document.createElement('span');
    chip.className = 'history-ref history-ref-' + (ref.type || 'branch');
    if (ref.current) chip.classList.add('is-current');
    chip.append(Icon.render(ref.type === 'tag' ? 'fa fa-tag' : 'fa fa-code-fork'));
    const name = document.createElement('span');
    name.textContent = ref.name;
    chip.append(name);
    chip.title = (ref.type === 'tag' ? 'tag: ' : '') + ref.name;
    return chip;
  }

  _select(hash, rowEl) {
    this.selected = hash;
    for (const r of this.graphPane.querySelectorAll('.history-row.is-selected')) r.classList.remove('is-selected');
    rowEl?.classList.add('is-selected');
    this._loadDetails(hash);
  }

  /** Load and render detail data for one commit. */
  async _loadDetails(hash) {
    this.detailsPane.innerHTML = '';
    this.detailsPane.append(el('div', 'history-details-loading', this._t('history.loading', 'Loading…')));
    try {
      const d = await this.api.get('/git/commit', { commit: hash });
      this._renderDetails(d);
    } catch (e) {
      this.detailsPane.innerHTML = '';
      this.detailsPane.append(el('div', 'history-details-loading', e.message));
    }
  }

  _renderEmptyDetails() {
    this.detailsPane.innerHTML = '';
    this.detailsPane.append(el('div', 'history-details-empty', this._t('history.select_hint', 'Select a commit to see its details.')));
  }

  /** Render selected commit metadata and changed-file action rows. */
  _renderDetails(d) {
    const pane = this.detailsPane;
    pane.innerHTML = '';
    const titleWrap = el('div', 'history-detail-title-wrap');
    titleWrap.append(this._commitMenuButton(d));
    titleWrap.append(el('div', 'history-detail-title', d.subject || ''));
    pane.append(titleWrap);
    if (d.body) {
      const body = el('pre', 'history-detail-body', d.body);
      pane.append(body);
    }
    const meta = document.createElement('dl');
    meta.className = 'history-detail-meta';
    const addMeta = (label, value) => {
      if (value === undefined || value === null || value === '') return;
      meta.append(el('dt', null, label), el('dd', null, value));
    };
    addMeta(this._t('history.commit', 'Commit'), d.hash);
    addMeta(this._t('history.author', 'Author'), this._person(d.author, d.email));
    addMeta(this._t('history.committer', 'Committer'), this._person(d.committer, d.committer_email));
    addMeta(this._t('history.date', 'Date'), formatDate(d.commit_date || d.date, true));
    const branches = Array.isArray(d.branches) ? d.branches : [];
    if (branches.length) addMeta(this._t('history.branches', 'Branches'), branches.join(', '));
    pane.append(meta);
    const files = Array.isArray(d.files) ? d.files : [];
    pane.append(el('div', 'history-detail-files-header', this._t('history.changed_files', 'Changed files') + ' (' + files.length + ')'));
    const list = el('div', 'history-detail-files');
    for (const f of files) list.append(this._renderFileRow(d.hash, f));
    pane.append(list);
  }

  _person(name, email) { return name && email ? `${name} <${email}>` : (name || email || ''); }

  _renderFileRow(commit, file) {
    const row = el('div', 'history-file-row');
    const badge = el('span', 'history-file-status history-file-status-' + (file.status || ''), file.status || '');
    badge.title = STATUS_LABELS[file.status] || file.status || '';
    const link = el('span', 'history-file-name', file.path);
    link.title = this._t('history.diff_to_parent', 'Show changes introduced by this commit');
    link.addEventListener('click', () => this._openCommitDiff(commit, file));
    row.append(badge, link);
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); this._openFileMenuAt(e.clientX, e.clientY, commit, file); });
    const actions = el('span', 'history-file-actions');
    actions.append(
      this._iconBtn('fa fa-file-o', this._t('history.open_file', 'Open file in editor'), () => this._openFile(file.path)),
      this._iconBtn('fa fa-exchange', this._t('history.diff_current', 'Diff with current version'), () => this._openDiffWithCurrent(commit, file)),
      this._fileMenuButton(commit, file)
    );
    row.append(actions);
    return row;
  }

  _iconBtn(icon, title, onClick) { return iconButton(icon, title, onClick); }
  _commitMenuButton(commit) { const button = this._iconBtn('fa fa-ellipsis-h', this._t('history.more_actions', 'More commit actions'), () => this._openCommitMenu(button, commit)); return button; }
  _fileMenuButton(commit, file) { const button = this._iconBtn('fa fa-ellipsis-h', this._t('files.more_actions', 'More actions'), () => this._openFileMenu(button, commit, file)); return button; }
  _openCommitMenu(anchor, commit) { PopupMenu.open(anchor, this._commitMenuItems(commit)); }
  _openCommitMenuAt(x, y, commit) { PopupMenu.openAt(x, y, this._commitMenuItems(commit)); }
  _openFileMenu(anchor, commit, file) { PopupMenu.open(anchor, this._fileMenuItems(commit, file)); }
  _openFileMenuAt(x, y, commit, file) { PopupMenu.openAt(x, y, this._fileMenuItems(commit, file)); }

  _fileMenuItems(commit, file) {
    return [
      { icon: 'fa fa-exchange', label: this._t('history.diff_to_parent', 'Show changes introduced by this commit'), onClick: () => this._openCommitDiff(commit, file) },
      { icon: 'fa fa-file-o', label: this._t('history.open_file', 'Open file in editor'), onClick: () => this._openFile(file.path) },
      { icon: 'fa fa-columns', label: this._t('history.diff_current', 'Diff with current version'), onClick: () => this._openDiffWithCurrent(commit, file) },
    ];
  }

  /** Build commit action menu including the nested reset-mode submenu. */
  _commitMenuItems(commit) {
    return [
      { icon: 'fa fa-code-fork', label: this._t('history.create_branch_from_commit', 'Create new branch from this commit'), onClick: () => this._promptCreateBranch(commit.hash) },
      { sep: true },
      { icon: 'fa fa-random', label: this._t('history.cherry_pick', 'Cherry-pick into current branch'), onClick: () => this._cherryPick(commit.hash) },
      { icon: 'fa fa-mail-reply', label: this._t('history.revert', 'Revert commit'), onClick: () => this._revert(commit.hash) },
      { icon: 'fa fa-compress', label: this._t('history.merge', 'Merge into current branch'), onClick: () => this._merge(commit.hash) },
      { icon: 'fa fa-undo', label: this._t('history.reset', 'Reset current branch to this commit'), children: [
        { icon: 'fa fa-step-backward', label: this._t('history.reset_soft', 'Soft reset'), onClick: () => this._reset(commit.hash, 'soft') },
        { icon: 'fa fa-circle-o', label: this._t('history.reset_mixed', 'Mixed reset'), onClick: () => this._reset(commit.hash, 'mixed') },
        { icon: 'fa fa-warning', label: this._t('history.reset_hard', 'Hard reset'), onClick: () => this._reset(commit.hash, 'hard') },
      ] },
    ];
  }

  async _openCommitDiff(commit, file) {
    try {
      const query = { commit, path: file.path };
      if (file.old_path) query.old_path = file.old_path;
      const diffData = await this.api.get('/git/commit-diff', query);
      const short = commit.slice(0, 8);
      this.onOpenDiff({ path: file.path, diffData, key: `histdiff:${commit}:${file.path}`, label: `${file.path.split('/').pop()} @ ${short}`, readOnly: true });
    } catch (e) { this.toasts.error(e.message); }
  }
  _openFile(path) { this.onOpenFile({ path, name: path.split('/').pop() }); }
  async _openDiffWithCurrent(commit, file) {
    try {
      const [oldData, current] = await Promise.all([
        this.api.get('/git/show', { commit, path: file.path }).catch(() => ({ content: '' })),
        this.api.get('/files/read', { path: file.path }).catch(() => ({ content: '' })),
      ]);
      const short = commit.slice(0, 8);
      this.onOpenDiff({ path: file.path, diffData: { old: oldData?.content || '', new: current?.content || '' }, key: `histcur:${commit}:${file.path}`, label: `${file.path.split('/').pop()} (${short} ↔ current)`, readOnly: true });
    } catch (e) { this.toasts.error(e.message); }
  }

  async _cherryPick(commit) { if (window.confirm(this._t('history.confirm_cherry_pick', 'Cherry-pick this commit into the current branch?'))) await this._runCommitAction('/git/cherry-pick', { commit }, this._t('history.cherry_pick_done', 'Cherry-picked commit'), 'cherry-pick'); }
  async _revert(commit) { if (window.confirm(this._t('history.confirm_revert', 'Revert this commit on the current branch?'))) await this._runCommitAction('/git/revert', { commit }, this._t('history.revert_done', 'Reverted commit'), 'revert'); }
  async _merge(commit) { if (window.confirm(this._t('history.confirm_merge', 'Merge the selected commit into the current branch?'))) await this._runCommitAction('/git/merge', { commit }, this._t('history.merge_done', 'Merged into current branch'), 'merge'); }
  async _reset(commit, mode) {
    const fallback = mode === 'hard' ? 'Hard reset the current branch to this commit? This will discard local changes and move branch history.' : `Reset the current branch to this commit using ${mode} mode?`;
    if (window.confirm(this._t(`history.confirm_reset_${mode}`, fallback))) await this._runCommitAction('/git/reset', { commit, mode }, this._t(`history.reset_${mode}_done`, `Reset (${mode}) completed`), 'reset');
  }

  async _promptCreateBranch(startPoint) {
    const branch = window.prompt(this._t('git.prompt_create_branch', 'New branch name'), this._suggestBranchName(startPoint));
    if (branch === null) return;
    const trimmed = String(branch).trim();
    if (trimmed) await this._createBranch(trimmed, startPoint);
  }
  _suggestBranchName(startPoint) { const source = String(startPoint || '').trim(); return (!source || source === 'HEAD') ? '' : source.slice(0, 8); }
  async _createBranch(branch, startPoint) {
    try {
      const resp = await this.api.post('/git/checkout', { branch, create: true, start_point: startPoint });
      this._injectConsole(resp);
      this.toasts.success(this._t('git.created_branch', 'Created branch') + ` ${branch}`);
      this.bus?.emit?.('git:branch-changed', { branch, startPoint, response: resp });
      this.bus?.emit?.('git:operation-completed', { operation: 'create-branch', branch, startPoint, response: resp, source: 'history-panel' });
      await this.refresh();
    } catch (e) { this._injectConsoleError(e); this.toasts.error(e.message); }
  }

  async _runCommitAction(path, payload, successMessage, operation = 'history-action') {
    try {
      const resp = await this.api.post(path, payload);
      this._injectConsole(resp);
      if (successMessage) this.toasts.success(successMessage + ' ✓');
      this.bus?.emit?.('git:history-action', { path, payload, response: resp });
      this.bus?.emit?.('git:operation-completed', { operation, path, payload, response: resp, source: 'history-panel' });
      this.bus?.emit?.('git:branch-changed', { response: resp });
      await this.refresh();
    } catch (e) { this._injectConsoleError(e); this.toasts.error(e.message); }
  }
  _injectConsole(resp) { const block = resp?.console; if (block && this.bus) this.bus.emit('console:inject', block); }
  _injectConsoleError(e) { const block = e?.details?.console; if (block && this.bus) this.bus.emit('console:inject', { ...block, ok: false, autoOpen: true }); }
}

const STATUS_LABELS = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed' };

function computeGraph(commits) {
  let lanes = [];
  let labels = [];
  const rows = [];
  let maxCols = 1;
  const colorFor = (lane) => GRAPH_COLORS[lane % GRAPH_COLORS.length];
  for (const c of commits) {
    const before = lanes.slice();
    const beforeLabels = labels.slice();
    let myLane = before.findIndex((h) => h === c.hash);
    if (myLane === -1) { myLane = before.findIndex((h) => h == null); if (myLane === -1) myLane = before.length; }
    const incoming = [];
    before.forEach((h, i) => { if (h === c.hash) incoming.push(i); });
    const refName = laneBranchName(c.refs);
    const nodeLabel = refName || beforeLabels[myLane] || '';
    const after = before.slice();
    const afterLabels = beforeLabels.slice();
    while (after.length <= myLane) { after.push(null); afterLabels.push(''); }
    for (let i = 0; i < after.length; i++) if (after[i] === c.hash) { after[i] = null; afterLabels[i] = ''; }
    const parents = c.parents || [];
    const outgoing = [];
    if (parents.length > 0) {
      after[myLane] = parents[0];
      afterLabels[myLane] = nodeLabel;
      outgoing.push(myLane);
      for (let p = 1; p < parents.length; p++) {
        let col = after.findIndex((h) => h === parents[p]);
        if (col === -1) { col = after.findIndex((h) => h == null); if (col === -1) col = after.length; while (afterLabels.length <= col) afterLabels.push(''); after[col] = parents[p]; }
        outgoing.push(col);
      }
    } else { after[myLane] = null; afterLabels[myLane] = ''; }
    while (after.length && after[after.length - 1] == null) { after.pop(); afterLabels.pop(); }
    const passes = [];
    const maxLen = Math.max(before.length, after.length);
    for (let i = 0; i < maxLen; i++) { const b = before[i]; if (b != null && b !== c.hash && i !== myLane && after[i] === b) passes.push(i); }
    rows.push({
      commit: c,
      node: { col: myLane, color: colorFor(myLane), label: nodeLabel },
      incoming: incoming.map((i) => ({ col: i, color: colorFor(i), label: beforeLabels[i] || nodeLabel })),
      outgoing: outgoing.map((i) => ({ col: i, color: colorFor(i), label: afterLabels[i] || '' })),
      passes: passes.map((i) => ({ col: i, color: colorFor(i), label: beforeLabels[i] || '' })),
    });
    maxCols = Math.max(maxCols, before.length, after.length, myLane + 1);
    lanes = after;
    labels = afterLabels;
  }
  return { rows, cols: maxCols };
}

function laneBranchName(refs) {
  if (!Array.isArray(refs) || refs.length === 0) return '';
  const order = { branch: 0, head: 1, remote: 2 };
  const candidates = refs.filter((r) => r && (r.type === 'branch' || r.type === 'head' || r.type === 'remote'));
  if (candidates.length === 0) return '';
  candidates.sort((a, b) => (Number(Boolean(b.current)) - Number(Boolean(a.current))) || ((order[a.type] ?? 9) - (order[b.type] ?? 9)));
  return candidates[0].name || '';
}

function renderGraphSvg(row, cols) {
  const width = Math.max(1, cols) * LANE_W;
  const mid = ROW_H / 2;
  const cx = (col) => col * LANE_W + LANE_W / 2;
  const nodeX = cx(row.node.col);
  const segs = [];
  const hits = [];
  for (const p of row.passes) { const x = cx(p.col); const d = `M ${x} 0 L ${x} ${ROW_H}`; segs.push(path(d, p.color)); hits.push(hitPath(d, p.label)); }
  for (const inc of row.incoming) { const x = cx(inc.col); const d = inc.col === row.node.col ? `M ${x} 0 L ${x} ${mid}` : `M ${x} 0 C ${x} ${mid} ${nodeX} 0 ${nodeX} ${mid}`; segs.push(path(d, inc.color)); hits.push(hitPath(d, inc.label)); }
  for (const out of row.outgoing) { const x = cx(out.col); const d = out.col === row.node.col ? `M ${x} ${mid} L ${x} ${ROW_H}` : `M ${nodeX} ${mid} C ${nodeX} ${ROW_H} ${x} ${mid} ${x} ${ROW_H}`; segs.push(path(d, out.color)); hits.push(hitPath(d, out.label)); }
  const nodeTitle = row.node.label ? `<title>${escapeAttr(row.node.label)}</title>` : '';
  return `<svg width="${width}" height="${ROW_H}" viewBox="0 0 ${width} ${ROW_H}">${segs.join('')}${hits.join('')}<circle class="history-node" cx="${nodeX}" cy="${mid}" r="${DOT_R}" fill="${row.node.color}">${nodeTitle}</circle></svg>`;
}
function path(d, color) { return `<path d="${d}" stroke="${color}" stroke-width="1.6" fill="none" />`; }
function hitPath(d, label) { return label ? `<path d="${d}" stroke="transparent" stroke-width="${LANE_W}" fill="none" style="cursor:default"><title>${escapeAttr(label)}</title></path>` : ''; }
function escapeAttr(value) { return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }
function formatDate(ts, withTime) {
  if (!ts) return '';
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const opts = withTime ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' } : { year: 'numeric', month: '2-digit', day: '2-digit' };
  return date.toLocaleString(undefined, opts);
}
function cssEscape(value) { if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value); return String(value).replace(/["\\]/g, '\\$&'); }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function iconButton(icon, title, onClick) { const b = document.createElement('button'); b.type = 'button'; b.className = 'tb-btn'; b.title = title; b.setAttribute('aria-label', title); b.append(Icon.render(icon)); b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); }); return b; }
