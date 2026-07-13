/**
 * Git history (commit graph) bottom panel.
 *
 * The panel is split in two halves:
 *   - left:  an interactive commit graph rendered as an SVG lane column next to
 *            an HTML table (subject, branch/tag labels, committer, date, hash).
 *            Lanes are drawn from each commit's parent list, the same data
 *            `git log` exposes, so arbitrary branch/merge topology renders
 *            without a heavyweight graph library.
 *   - right: details of the selected commit plus its changed files. Each file is
 *            a link opening the commit-vs-parent diff; two inline icons open the
 *            file in a regular editor or diff the commit against the current
 *            working copy.
 *
 * Branches and tags are shown as text chips (not color alone) so the graph
 * stays readable for users with limited color vision.
 *
 * Contents load lazily on first mount and refresh only via the toolbar button.
 */
import { Icon } from '../core/Icon.js';
import { attachSplitter } from '../layout/Splitter.js';

// Lane geometry. Kept small so many branches fit, but large enough to click.
const LANE_W = 14;
const ROW_H = 28;
const DOT_R = 4;

// High-contrast lane palette. Color is only a secondary cue here: branch names
// are always shown as text, so this set just needs to separate adjacent lanes.
const GRAPH_COLORS = [
  '#2563eb', '#16a34a', '#db2777', '#d97706',
  '#7c3aed', '#0891b2', '#dc2626', '#65a30d',
  '#c026d3', '#0d9488', '#ea580c', '#4f46e5',
];

const HISTORY_LIMIT = 200;

export class HistoryPanel {
  /**
   * @param {Object} deps
   * @param {import('../core/ApiClient.js').ApiClient} deps.api
   * @param {Object} deps.i18n
   * @param {Object} deps.toasts
   * @param {Object} deps.bus
   * @param {(opts: {path:string, diffData:{old:string,new:string}, key:string, label:string, readOnly:boolean}) => void} deps.onOpenDiff
   * @param {(entry: {path:string, name:string}) => void} deps.onOpenFile
   */
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
    this.graphWidth = 60; // percent of the split width taken by the graph pane
  }

  _t(key, fallback) {
    const v = this.i18n?.t?.(key);
    return v && v !== key ? v : fallback;
  }

  mount(host) {
    this.host = host;
    host.innerHTML = '';
    host.classList.add('history-panel');

    const toolbar = document.createElement('div');
    toolbar.className = 'panel-toolbar';
    toolbar.append(this._buildSearch());
    toolbar.append(this._tbBtn('fa fa-refresh', this._t('actions.refresh', 'Refresh'), () => this.refresh()));
    host.append(toolbar);

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
    host.append(split);
    this.splitEl = split;

    attachSplitter(this.splitter, {
      orientation: 'vertical',
      onResize: {
        getSize: () => {
          const total = this.splitEl?.clientWidth || 1;
          return (this.graphWidth / 100) * total;
        },
        apply: (px) => {
          const total = this.splitEl?.clientWidth || 1;
          const pct = Math.max(15, Math.min(85, (px / total) * 100));
          this.graphWidth = pct;
          this.graphPane.style.flex = `0 0 ${pct}%`;
        }
      }
    });

    if (!this._loaded) {
      this.refresh();
    } else {
      this._renderGraph();
    }
  }

  /**
   * Search box shown to the left of the refresh button. Typing filters the
   * history server-side across all columns; while a filter is active the branch
   * lanes are hidden because the result is no longer a contiguous graph.
   */
  _buildSearch() {
    const wrap = document.createElement('div');
    wrap.className = 'history-search';
    wrap.append(Icon.render('fa fa-search'));
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'history-search-input';
    input.placeholder = this._t('history.search_placeholder', 'Search history…');
    input.value = this.search;
    input.setAttribute('aria-label', this._t('history.search_placeholder', 'Search history…'));
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

  async refresh() {
    if (!this.graphPane) return;
    this.graphPane.textContent = '…';
    try {
      const params = { limit: HISTORY_LIMIT };
      if (this.search) params.search = this.search;
      const data = await this.api.get('/git/history', params);
      this.commits = Array.isArray(data?.commits) ? data.commits : [];
      this._loaded = true;
      this._graph = computeGraph(this.commits);
      this._renderGraph();
    } catch (e) {
      this.graphPane.textContent = e.message;
    }
  }

  _renderGraph() {
    const pane = this.graphPane;
    pane.innerHTML = '';
    if (!this.commits.length) {
      pane.classList.add('is-empty');
      pane.textContent = this.search
        ? this._t('history.no_matches', 'No matching commits')
        : this._t('history.empty', 'No commits');
      return;
    }
    pane.classList.remove('is-empty');

    const graph = this._graph || computeGraph(this.commits);
    const graphWidth = Math.max(1, graph.cols) * LANE_W;
    // While a search filter is active the result is no longer a contiguous
    // graph, so the branch lanes are hidden and only the commit rows are shown.
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
      } else {
        graphCell.classList.add('is-hidden');
      }

      const subjectCell = document.createElement('div');
      subjectCell.className = 'history-subject';
      for (const ref of c.refs || []) {
        subjectCell.append(this._renderRefChip(ref));
      }
      const subjectText = document.createElement('span');
      subjectText.className = 'history-subject-text';
      subjectText.textContent = c.subject || '';
      subjectText.title = c.subject || '';
      subjectCell.append(subjectText);

      const authorCell = document.createElement('div');
      authorCell.className = 'history-author';
      authorCell.textContent = c.author || c.committer || '';
      authorCell.title = c.author || c.committer || '';

      const dateCell = document.createElement('div');
      dateCell.className = 'history-date';
      dateCell.textContent = formatDate(c.commit_date || c.date, false);
      dateCell.title = formatDate(c.commit_date || c.date, true);

      const hashCell = document.createElement('div');
      hashCell.className = 'history-hash';
      hashCell.textContent = (c.hash || '').slice(0, 8);

      tr.append(graphCell, subjectCell, authorCell, dateCell, hashCell);
      tr.addEventListener('click', () => this._select(c.hash, tr));
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._select(c.hash, tr); }
      });
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._openCommitMenuAt(e.clientX, e.clientY, c);
      });
      table.append(tr);
    }

    pane.append(table);

    if (this.selected) {
      const sel = pane.querySelector(`.history-row[data-hash="${cssEscape(this.selected)}"]`);
      if (sel) sel.classList.add('is-selected');
    }
  }

  _renderRefChip(ref) {
    const chip = document.createElement('span');
    chip.className = 'history-ref history-ref-' + (ref.type || 'branch');
    if (ref.current) chip.classList.add('is-current');
    const icon = ref.type === 'tag' ? 'fa fa-tag' : 'fa fa-code-fork';
    chip.append(Icon.render(icon));
    const name = document.createElement('span');
    name.textContent = ref.name;
    chip.append(name);
    chip.title = (ref.type === 'tag' ? 'tag: ' : '') + ref.name;
    return chip;
  }

  _select(hash, rowEl) {
    this.selected = hash;
    for (const r of this.graphPane.querySelectorAll('.history-row.is-selected')) {
      r.classList.remove('is-selected');
    }
    rowEl?.classList.add('is-selected');
    this._loadDetails(hash);
  }

  async _loadDetails(hash) {
    this.detailsPane.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'history-details-loading';
    loading.textContent = this._t('history.loading', 'Loading…');
    this.detailsPane.append(loading);
    try {
      const d = await this.api.get('/git/commit', { commit: hash });
      this._renderDetails(d);
    } catch (e) {
      this.detailsPane.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'history-details-loading';
      err.textContent = e.message;
      this.detailsPane.append(err);
    }
  }

  _renderEmptyDetails() {
    this.detailsPane.innerHTML = '';
    const hint = document.createElement('div');
    hint.className = 'history-details-empty';
    hint.textContent = this._t('history.select_hint', 'Select a commit to see its details.');
    this.detailsPane.append(hint);
  }

  _renderDetails(d) {
    const pane = this.detailsPane;
    pane.innerHTML = '';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'history-detail-title-wrap';

    titleWrap.append(this._commitMenuButton(d));

    const title = document.createElement('div');
    title.className = 'history-detail-title';
    title.textContent = d.subject || '';
    titleWrap.append(title);
    pane.append(titleWrap);

    if (d.body) {
      const body = document.createElement('pre');
      body.className = 'history-detail-body';
      body.textContent = d.body;
      pane.append(body);
    }

    const meta = document.createElement('dl');
    meta.className = 'history-detail-meta';
    const addMeta = (label, value) => {
      if (value === undefined || value === null || value === '') return;
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      meta.append(dt, dd);
    };
    addMeta(this._t('history.commit', 'Commit'), d.hash);
    addMeta(this._t('history.author', 'Author'), this._person(d.author, d.email));
    addMeta(this._t('history.committer', 'Committer'), this._person(d.committer, d.committer_email));
    addMeta(this._t('history.date', 'Date'), formatDate(d.commit_date || d.date, true));
    const branches = Array.isArray(d.branches) ? d.branches : [];
    if (branches.length) {
      addMeta(this._t('history.branches', 'Branches'), branches.join(', '));
    }
    pane.append(meta);

    const filesHeader = document.createElement('div');
    filesHeader.className = 'history-detail-files-header';
    const files = Array.isArray(d.files) ? d.files : [];
    filesHeader.textContent = this._t('history.changed_files', 'Changed files') + ' (' + files.length + ')';
    pane.append(filesHeader);

    const list = document.createElement('div');
    list.className = 'history-detail-files';
    for (const f of files) {
      list.append(this._renderFileRow(d.hash, f));
    }
    pane.append(list);
  }

  _person(name, email) {
    if (!name && !email) return '';
    if (name && email) return `${name} <${email}>`;
    return name || email;
  }

  _renderFileRow(commit, file) {
    const row = document.createElement('div');
    row.className = 'history-file-row';

    const badge = document.createElement('span');
    badge.className = 'history-file-status history-file-status-' + (file.status || '');
    badge.textContent = file.status || '';
    badge.title = STATUS_LABELS[file.status] || file.status || '';
    row.append(badge);

    const link = document.createElement('span');
    link.className = 'history-file-name';
    link.textContent = file.path;
    link.title = this._t('history.diff_to_parent', 'Show changes introduced by this commit');
    link.addEventListener('click', () => this._openCommitDiff(commit, file));
    row.append(link);

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._openFileMenuAt(e.clientX, e.clientY, commit, file);
    });

    const actions = document.createElement('span');
    actions.className = 'history-file-actions';
    actions.append(
      this._iconBtn('fa fa-file-o', this._t('history.open_file', 'Open file in editor'), () => this._openFile(file.path)),
      this._iconBtn('fa fa-exchange', this._t('history.diff_current', 'Diff with current version'), () => this._openDiffWithCurrent(commit, file)),
      this._fileMenuButton(commit, file)
    );
    row.append(actions);
    return row;
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

  _commitMenuButton(commit) {
    const button = this._iconBtn(
      'fa fa-ellipsis-h',
      this._t('history.more_actions', 'More commit actions'),
      () => this._openCommitMenu(button, commit)
    );
    return button;
  }

  _fileMenuButton(commit, file) {
    const button = this._iconBtn(
      'fa fa-ellipsis-h',
      this._t('files.more_actions', 'More actions'),
      () => this._openFileMenu(button, commit, file)
    );
    return button;
  }

  _openCommitMenu(anchor, commit) {
    HistoryPopupMenu.open(anchor, this._commitMenuItems(commit));
  }

  _openCommitMenuAt(x, y, commit) {
    HistoryPopupMenu.openAt(x, y, this._commitMenuItems(commit));
  }

  _openFileMenu(anchor, commit, file) {
    HistoryPopupMenu.open(anchor, this._fileMenuItems(commit, file));
  }

  _openFileMenuAt(x, y, commit, file) {
    HistoryPopupMenu.openAt(x, y, this._fileMenuItems(commit, file));
  }

  _fileMenuItems(commit, file) {
    return [
      {
        icon: 'fa fa-exchange',
        label: this._t('history.diff_to_parent', 'Show changes introduced by this commit'),
        onClick: () => this._openCommitDiff(commit, file),
      },
      {
        icon: 'fa fa-file-o',
        label: this._t('history.open_file', 'Open file in editor'),
        onClick: () => this._openFile(file.path),
      },
      {
        icon: 'fa fa-columns',
        label: this._t('history.diff_current', 'Diff with current version'),
        onClick: () => this._openDiffWithCurrent(commit, file),
      },
    ];
  }

  _commitMenuItems(commit) {
    return [
      {
        icon: 'fa fa-code-fork',
        label: this._t('history.create_branch_from_commit', 'Create new branch from this commit'),
        onClick: () => this._promptCreateBranch(commit.hash),
      },
      { sep: true },
      {
        icon: 'fa fa-random',
        label: this._t('history.cherry_pick', 'Cherry-pick into current branch'),
        onClick: () => this._cherryPick(commit.hash),
      },
      {
        icon: 'fa fa-mail-reply',
        label: this._t('history.revert', 'Revert commit'),
        onClick: () => this._revert(commit.hash),
      },
      {
        icon: 'fa fa-compress',
        label: this._t('history.merge', 'Merge into current branch'),
        onClick: () => this._merge(commit.hash),
      },
      {
        icon: 'fa fa-undo',
        label: this._t('history.reset', 'Reset current branch to this commit'),
        children: [
          {
            icon: 'fa fa-step-backward',
            label: this._t('history.reset_soft', 'Soft reset'),
            onClick: () => this._reset(commit.hash, 'soft'),
          },
          {
            icon: 'fa fa-circle-o',
            label: this._t('history.reset_mixed', 'Mixed reset'),
            onClick: () => this._reset(commit.hash, 'mixed'),
          },
          {
            icon: 'fa fa-warning',
            label: this._t('history.reset_hard', 'Hard reset'),
            onClick: () => this._reset(commit.hash, 'hard'),
          },
        ],
      },
    ];
  }

  async _openCommitDiff(commit, file) {
    try {
      const query = { commit, path: file.path };
      if (file.old_path) query.old_path = file.old_path;
      const diffData = await this.api.get('/git/commit-diff', query);
      const short = commit.slice(0, 8);
      this.onOpenDiff({
        path: file.path,
        diffData,
        key: `histdiff:${commit}:${file.path}`,
        label: `${file.path.split('/').pop()} @ ${short}`,
        readOnly: true,
      });
    } catch (e) {
      this.toasts.error(e.message);
    }
  }

  _openFile(path) {
    this.onOpenFile({ path, name: path.split('/').pop() });
  }

  async _openDiffWithCurrent(commit, file) {
    try {
      const [oldData, current] = await Promise.all([
        this.api.get('/git/show', { commit, path: file.path }).catch(() => ({ content: '' })),
        this.api.get('/files/read', { path: file.path }).catch(() => ({ content: '' })),
      ]);
      const short = commit.slice(0, 8);
      this.onOpenDiff({
        path: file.path,
        diffData: { old: oldData?.content || '', new: current?.content || '' },
        key: `histcur:${commit}:${file.path}`,
        label: `${file.path.split('/').pop()} (${short} ↔ current)`,
        readOnly: true,
      });
    } catch (e) {
      this.toasts.error(e.message);
    }
  }

  async _cherryPick(commit) {
    if (!window.confirm(this._t('history.confirm_cherry_pick', 'Cherry-pick this commit into the current branch?'))) return;
    await this._runCommitAction('/git/cherry-pick', { commit }, this._t('history.cherry_pick_done', 'Cherry-picked commit'));
  }

  async _revert(commit) {
    if (!window.confirm(this._t('history.confirm_revert', 'Revert this commit on the current branch?'))) return;
    await this._runCommitAction('/git/revert', { commit }, this._t('history.revert_done', 'Reverted commit'));
  }

  async _merge(commit) {
    if (!window.confirm(this._t('history.confirm_merge', 'Merge the selected commit into the current branch?'))) return;
    await this._runCommitAction('/git/merge', { commit }, this._t('history.merge_done', 'Merged into current branch'));
  }

  async _reset(commit, mode) {
    const key = `history.confirm_reset_${mode}`;
    const fallback = mode === 'hard'
      ? 'Hard reset the current branch to this commit? This will discard local changes and move branch history.'
      : `Reset the current branch to this commit using ${mode} mode?`;
    if (!window.confirm(this._t(key, fallback))) return;
    await this._runCommitAction('/git/reset', { commit, mode }, this._t(`history.reset_${mode}_done`, `Reset (${mode}) completed`));
  }

  async _promptCreateBranch(startPoint) {
    const branch = window.prompt(
      this._t('git.prompt_create_branch', 'New branch name'),
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
    return source.slice(0, 8);
  }

  async _createBranch(branch, startPoint) {
    try {
      const payload = { branch, create: true, start_point: startPoint };
      const resp = await this.api.post('/git/checkout', payload);
      this._injectConsole(resp);
      this.toasts.success((this._t('git.created_branch', 'Created branch')) + ` ${branch}`);
      this.bus?.emit?.('git:branch-changed', { branch, startPoint, response: resp });
      await this.refresh();
    } catch (e) {
      this._injectConsoleError(e);
      this.toasts.error(e.message);
    }
  }

  async _runCommitAction(path, payload, successMessage) {
    try {
      const resp = await this.api.post(path, payload);
      this._injectConsole(resp);
      if (successMessage) this.toasts.success(successMessage + ' ✓');
      this.bus?.emit?.('git:history-action', { path, payload, response: resp });
      this.bus?.emit?.('git:branch-changed', { response: resp });
      await this.refresh();
    } catch (e) {
      this._injectConsoleError(e);
      this.toasts.error(e.message);
    }
  }

  _injectConsole(resp) {
    const block = resp?.console;
    if (block && this.bus) this.bus.emit('console:inject', block);
  }

  _injectConsoleError(e) {
    const block = e?.details?.console;
    if (block && this.bus) this.bus.emit('console:inject', { ...block, ok: false, autoOpen: true });
  }
}

const STATUS_LABELS = {
  A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed',
};

/**
 * Assign a lane (column) to every commit and describe the line segments to draw
 * for each row. Processes commits newest-first (git log order); each active lane
 * holds the hash of the commit it is waiting to draw next, so a commit's
 * children sit above it and its parents are routed below.
 *
 * @param {Array<{hash:string,parents:string[]}>} commits
 * @returns {{rows: Array, cols: number}}
 */
function computeGraph(commits) {
  let lanes = []; // active lanes: hash each lane waits for, or null
  let labels = []; // branch name currently flowing in each lane (parallel to lanes)
  const rows = [];
  let maxCols = 1;
  const colorFor = (lane) => GRAPH_COLORS[lane % GRAPH_COLORS.length];

  for (const c of commits) {
    const before = lanes.slice();
    const beforeLabels = labels.slice();

    // The commit's own lane: a child already reserved it, otherwise take the
    // first free slot (a new branch tip within the visible window).
    let myLane = before.findIndex((h) => h === c.hash);
    if (myLane === -1) {
      myLane = before.findIndex((h) => h == null);
      if (myLane === -1) myLane = before.length;
    }

    // Incoming lines: every lane above that was waiting for this commit.
    const incoming = [];
    before.forEach((h, i) => { if (h === c.hash) incoming.push(i); });

    // Branch flowing through this commit: a ref on the commit itself wins,
    // otherwise inherit the label a child reserved on this lane.
    const refName = laneBranchName(c.refs);
    const nodeLabel = refName || beforeLabels[myLane] || '';

    const after = before.slice();
    const afterLabels = beforeLabels.slice();
    while (after.length <= myLane) { after.push(null); afterLabels.push(''); }
    for (let i = 0; i < after.length; i++) {
      if (after[i] === c.hash) { after[i] = null; afterLabels[i] = ''; }
    }

    // Route parents below: first parent reuses this lane, extra parents (merge)
    // reuse an existing lane already waiting for them or claim a free slot.
    const parents = c.parents || [];
    const outgoing = [];
    if (parents.length > 0) {
      after[myLane] = parents[0];
      afterLabels[myLane] = nodeLabel; // first-parent lane carries this branch on
      outgoing.push(myLane);
      for (let p = 1; p < parents.length; p++) {
        let col = after.findIndex((h) => h === parents[p]);
        if (col === -1) {
          col = after.findIndex((h) => h == null);
          if (col === -1) col = after.length;
          while (afterLabels.length <= col) afterLabels.push('');
          after[col] = parents[p];
          afterLabels[col] = afterLabels[col] || '';
        }
        outgoing.push(col);
      }
    } else {
      after[myLane] = null; // root commit
      afterLabels[myLane] = '';
    }

    while (after.length && after[after.length - 1] == null) { after.pop(); afterLabels.pop(); }

    // Pass-through lanes: unrelated branches that simply continue past this row.
    const passes = [];
    const maxLen = Math.max(before.length, after.length);
    for (let i = 0; i < maxLen; i++) {
      const b = before[i];
      if (b == null || b === c.hash || i === myLane) continue;
      if (after[i] === b) passes.push(i);
    }

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

/**
 * Pick the most relevant branch name from a commit's refs for lane labelling.
 * Prefers the checked-out branch, then a local branch, then a remote one.
 * Tags are ignored here — they are not branches.
 */
function laneBranchName(refs) {
  if (!Array.isArray(refs) || refs.length === 0) return '';
  const order = { branch: 0, head: 1, remote: 2 };
  const candidates = refs.filter((r) => r && (r.type === 'branch' || r.type === 'head' || r.type === 'remote'));
  if (candidates.length === 0) return '';
  candidates.sort((a, b) => (Number(Boolean(b.current)) - Number(Boolean(a.current)))
    || ((order[a.type] ?? 9) - (order[b.type] ?? 9)));
  return candidates[0].name || '';
}

/** Build the SVG markup for a single graph row. */
function renderGraphSvg(row, cols) {
  const width = Math.max(1, cols) * LANE_W;
  const mid = ROW_H / 2;
  const cx = (col) => col * LANE_W + LANE_W / 2;
  const nodeX = cx(row.node.col);
  const segs = [];
  const hits = []; // transparent wide overlays carrying the branch tooltip

  // Straight pass-through lanes.
  for (const p of row.passes) {
    const x = cx(p.col);
    const d = `M ${x} 0 L ${x} ${ROW_H}`;
    segs.push(path(d, p.color));
    hits.push(hitPath(d, p.label));
  }
  // Child lanes coming down into the node (top half).
  for (const inc of row.incoming) {
    const x = cx(inc.col);
    const d = inc.col === row.node.col
      ? `M ${x} 0 L ${x} ${mid}`
      : `M ${x} 0 C ${x} ${mid} ${nodeX} 0 ${nodeX} ${mid}`;
    segs.push(path(d, inc.color));
    hits.push(hitPath(d, inc.label));
  }
  // Parent lanes leaving the node (bottom half).
  for (const out of row.outgoing) {
    const x = cx(out.col);
    const d = out.col === row.node.col
      ? `M ${x} ${mid} L ${x} ${ROW_H}`
      : `M ${nodeX} ${mid} C ${nodeX} ${ROW_H} ${x} ${mid} ${x} ${ROW_H}`;
    segs.push(path(d, out.color));
    hits.push(hitPath(d, out.label));
  }

  const nodeTitle = row.node.label ? `<title>${escapeAttr(row.node.label)}</title>` : '';
  const node = `<circle class="history-node" cx="${nodeX}" cy="${mid}" r="${DOT_R}" fill="${row.node.color}">${nodeTitle}</circle>`;
  return `<svg width="${width}" height="${ROW_H}" viewBox="0 0 ${width} ${ROW_H}">${segs.join('')}${hits.join('')}${node}</svg>`;
}

function path(d, color) {
  return `<path d="${d}" stroke="${color}" stroke-width="1.6" fill="none" />`;
}

/**
 * Invisible, wide stroke laid over a lane so the (thin) line is easy to hover.
 * Carries an SVG `<title>` that the browser renders as a native tooltip.
 */
function hitPath(d, label) {
  if (!label) return '';
  return `<path d="${d}" stroke="transparent" stroke-width="${LANE_W}" fill="none" style="cursor:default">`
    + `<title>${escapeAttr(label)}</title></path>`;
}

function escapeAttr(value) {
  return String(value).replace(/[&<>"]/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]
  ));
}

function formatDate(ts, withTime) {
  if (!ts) return '';
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const opts = withTime
    ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: '2-digit', day: '2-digit' };
  return date.toLocaleString(undefined, opts);
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

/**
 * Shared popup-menu controller that supports one nested submenu chain without
 * closing the parent menu. The submenu stays open only while the pointer or
 * focus remains inside the active menu path, so reset-mode submenus behave like
 * regular desktop menus instead of becoming detached floating layers.
 */
const HistoryPopupMenu = createPopupMenuController();

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
