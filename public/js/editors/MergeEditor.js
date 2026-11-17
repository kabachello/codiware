import { EventBus } from '../core/EventBus.js';
import { Icon } from '../core/Icon.js';
import { attachSplitter } from '../layout/Splitter.js';
import { loadMonaco } from './monacoLoader.js';
import { detectLanguage } from './DiffEditor.js';

const MARKERS = /^\uFEFF?(?:<{7,}|={7,}|>{7,}|\|{7,})(?:[ \r].*)?$/m;

/** Offsets include original line endings, so choices preserve CRLF and final newlines. */
export function parseConflicts(content) {
  const lines = [...content.matchAll(/[^\n]*(?:\n|$)/g)].filter(match => match[0] !== '');
  const conflicts = [];
  let block = null;
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index][0].replace(/\r?\n$/, '');
    const offset = lines[index].index;
    const start = text.match(/^(<{7,})(?: (.*))?$/);
    if (start) {
      block = { start: offset, startLine: index + 1, oursStart: offset + lines[index][0].length, width: start[1].length, oursLabel: start[2] || '' };
    } else if (block) {
      const marker = character => new RegExp(`^\\${character}{${block.width}}(?: .*)?$`).test(text);
      if (marker('|') && block.separator === undefined && block.baseStart === undefined) {
        block.oursEnd = offset;
        block.baseStart = offset + lines[index][0].length;
        block.baseLabel = text.slice(block.width).trim();
      } else if (text === '='.repeat(block.width) && block.separator === undefined) {
        block.oursEnd ??= offset;
        block.baseEnd = offset;
        block.separator = offset + lines[index][0].length;
      } else if (marker('>') && block.separator !== undefined) {
        conflicts.push({
          start: block.start,
          end: offset + lines[index][0].length,
          startLine: block.startLine,
          endLine: index + 1,
          ours: content.slice(block.oursStart, block.oursEnd),
          theirs: content.slice(block.separator, offset),
          base: block.baseStart === undefined ? null : content.slice(block.baseStart, block.baseEnd),
          labels: { ours: block.oursLabel, theirs: text.slice(block.width).trim(), base: block.baseLabel || '' },
        });
        block = null;
      }
    }
  }
  return { conflicts, hasMarkers: MARKERS.test(content) };
}

export class MergeEditor {
  constructor(host, ctx) {
    this.host = host;
    this.ctx = ctx;
    this._bus = new EventBus();
    this._panes = {};
    this._zones = [];
    this._disposables = [];
    this._saved = null;
    this._destroyed = false;
    this._busy = false;
    this._resolved = false;
    this._ready = false;
    this._deleted = false;
    this._build();
    this._initializing = this._init();
    this._initializing.catch(error => {
      if (this._destroyed) return;
      this._status.textContent = this._t('load_error', { message: error.message });
      this._status.setAttribute('role', 'alert');
      ctx.toasts.error(this._status.textContent);
      console.error('[codiware] Merge editor failed:', error);
    });
  }

  _t(key, values) { return this.ctx.i18n.t(`merge.${key}`, values); }

  _button(label, action, icon = null) {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    if (icon) {
      button.className = 'ide-editor-tool';
      button.append(Icon.render(icon));
    } else {
      button.textContent = label;
    }
    button.addEventListener('click', action);
    return button;
  }

  _build() {
    this._root = document.createElement('div');
    this._root.className = 'ide-merge-editor';
    const toolbar = document.createElement('div');
    toolbar.className = 'ide-editor-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', this._t('title'));
    this._previous = this._button(this._t('previous'), () => this._navigate(-1), 'fa fa-arrow-up');
    this._next = this._button(this._t('next'), () => this._navigate(1), 'fa fa-arrow-down');
    this._baseToggle = this._button(this._t('show_base'), () => {
      const pane = this._panes.base.section;
      pane.hidden = !pane.hidden;
      this._baseToggle.setAttribute('aria-pressed', String(!pane.hidden));
    }, 'fa fa-columns');
    this._baseToggle.setAttribute('aria-pressed', 'false');
    this._status = document.createElement('span');
    this._status.className = 'ide-merge-status';
    this._status.setAttribute('role', 'status');
    this._status.setAttribute('aria-live', 'polite');
    this._status.textContent = this._t('loading');
    this._complete = this._button(this._t('complete'), () => this._bus.emit('complete-request', this));
    this._complete.className = 'primary';
    this._complete.disabled = true;
    toolbar.append(this._previous, this._next, this._baseToggle, this._status, this._complete);

    this._help = document.createElement('div');
    this._help.className = 'ide-merge-help';
    this._help.textContent = this._t('help');
    this._inputs = document.createElement('div');
    this._inputs.className = 'ide-merge-inputs';
    for (const name of ['ours', 'theirs', 'base']) {
      const pane = this._createPane(name);
      this._inputs.append(pane.section);
      pane.section.hidden = name === 'base';
    }
    const splitter = document.createElement('div');
    splitter.className = 'ide-splitter ide-merge-splitter';
    splitter.setAttribute('role', 'separator');
    splitter.setAttribute('aria-orientation', 'horizontal');
    splitter.setAttribute('aria-label', this._t('resize'));
    splitter.tabIndex = 0;
    const setHeight = value => {
      const height = Math.max(100, Math.min(this._root.clientHeight - 200, value));
      this._inputs.style.flex = `0 0 ${height}px`;
    };
    this._detachSplitter = attachSplitter(splitter, {
      orientation: 'horizontal',
      onResize: { getSize: () => this._inputs.offsetHeight, apply: setHeight },
    });
    splitter.addEventListener('keydown', event => {
      if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      setHeight(this._inputs.offsetHeight + (event.key === 'ArrowUp' ? -20 : 20));
    });
    const result = this._createPane('result');
    const deletionLabel = document.createElement('label');
    deletionLabel.className = 'ide-merge-delete';
    this._deleteInput = document.createElement('input');
    this._deleteInput.type = 'checkbox';
    this._deleteInput.addEventListener('change', () => {
      this._deleted = this._deleteInput.checked;
      this._update();
      this._bus.emit('change', this);
    });
    deletionLabel.append(this._deleteInput, document.createTextNode(this._t('delete_result')));
    result.header.append(deletionLabel);
    this._resolveToolbar = document.createElement('div');
    this._resolveToolbar.className = 'ide-editor-toolbar ide-merge-resolve-toolbar';
    this._resolveToolbar.setAttribute('role', 'toolbar');
    this._resolveToolbar.setAttribute('aria-label', this._t('resolve_conflict'));
    this._conflictSelect = document.createElement('select');
    this._conflictSelect.setAttribute('aria-label', this._t('select_conflict'));
    this._conflictSelect.addEventListener('change', () => {
      const conflict = this._conflicts[Number(this._conflictSelect.value)];
      if (conflict) this._reveal(conflict);
    });
    this._resolveToolbar.append(this._conflictSelect);
    this._choiceButtons = ['ours', 'theirs', 'both', 'base'].map(choice => {
      const button = this._button(this._t(`accept_${choice}`), () => {
        const conflict = this._conflicts[Number(this._conflictSelect.value)];
        if (conflict) this._accept(conflict, choice);
      });
      this._resolveToolbar.append(button);
      return button;
    });
    this._resolveToolbar.hidden = true;
    result.header.after(this._resolveToolbar);
    this._root.append(toolbar, this._help, this._inputs, splitter, result.section);
    this.host.replaceChildren(this._root);
    this._updateControls();
  }

  _createPane(name) {
    const section = document.createElement('section');
    section.className = `ide-merge-pane ide-merge-${name}`;
    section.setAttribute('aria-label', this._t(name));
    const header = document.createElement('div');
    header.className = 'ide-merge-pane-header';
    const title = document.createElement('strong');
    title.textContent = this._t(name);
    const hint = document.createElement('span');
    hint.className = 'ide-merge-pane-hint';
    hint.textContent = this._t(`${name}_hint`);
    const heading = document.createElement('div');
    heading.append(title, hint);
    header.append(heading);
    let use;
    if (name === 'ours' || name === 'theirs') {
      use = this._button(this._t('use_file'), () => this._useFile(name));
      use.disabled = true;
      header.append(use);
    }
    const container = document.createElement('div');
    container.className = 'ide-merge-code';
    section.append(header, container);
    return (this._panes[name] = { section, header, title, hint, container, use });
  }

  async _init() {
    const monaco = await loadMonaco();
    if (this._destroyed) return;
    this._monaco = monaco;
    const applyTheme = () => monaco.editor.setTheme(document.documentElement.dataset.theme === 'dark' ? 'vs-dark' : 'vs');
    applyTheme();
    this._themeObserver = new MutationObserver(applyTheme);
    this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    for (const [name, pane] of Object.entries(this._panes)) {
      pane.editor = monaco.editor.create(pane.container, {
        automaticLayout: true,
        readOnly: name !== 'result',
        domReadOnly: name !== 'result',
        ariaLabel: this._t(name),
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
        glyphMargin: true,
      });
      this._disposables.push(pane.editor.onKeyDown(event => {
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.keyCode === monaco.KeyCode.KeyS) {
          event.preventDefault();
          event.stopPropagation();
          this._bus.emit('save-request', this);
        }
      }));
    }
    this._ready = true;
    if (this._pendingData) {
      this._applyData(this._pendingData);
      this._pendingData = null;
    }
  }

  load(data) {
    if (this._ready) this._applyData(data);
    else this._pendingData = data;
  }

  _applyData(data) {
    this._data = data;
    this._resolved = false;
    this._token = data.token;
    this._deleted = data.deleted;
    this._savedDeleted = data.deleted;
    this._deleteInput.checked = data.deleted;
    this._sourceLabels = parseConflicts(data.result).conflicts[0]?.labels || {};
    this._updateSourceTitles();
    const language = detectLanguage(data.path);
    for (const [name, pane] of Object.entries(this._panes)) {
      pane.editor.setModel(null);
      pane.model?.dispose();
      pane.model = this._monaco.editor.createModel(name === 'result' ? data.result : data[name].content, language);
      pane.editor.setModel(pane.model);
      if (name !== 'result') {
        pane.hint.textContent = this._t(!data[name].exists ? (name === 'base' ? 'no_base' : 'side_deleted') : data.rebasing && name !== 'base' ? `rebase_${name}_hint` : `${name}_hint`);
      }
    }
    this._help.textContent = this._t(data.rebasing ? 'rebase_help' : 'help');
    this._saved = this.getSavePayload().content;
    this._contentChangeHandler?.dispose();
    this._contentChangeHandler = this._panes.result.model.onDidChangeContent(() => {
      this._update();
      this._bus.emit('change', this);
    });
    this._update();
    if (this._conflicts.length) this._reveal(this._conflicts[0]);
  }

  _updateSourceTitles() {
    for (const name of ['ours', 'theirs', 'base']) {
      const pane = this._panes[name];
      const label = this._sourceLabels[name] || '';
      const shortLabel = label.replace(/^[0-9a-f]{12,64}\b/i, hash => hash.slice(0, 8));
      const title = label ? `${this._t(name)}, ${shortLabel}` : this._t(name);
      pane.title.textContent = title;
      pane.title.title = label ? `${this._t(name)}, ${label}` : title;
      pane.section.setAttribute('aria-label', title);
      pane.editor?.updateOptions({ ariaLabel: title });
    }
  }

  _updateControls() {
    const disabled = !this._ready || !this._data || this._busy || this._resolved;
    const hasConflicts = Boolean(this._conflicts?.length);
    this._previous.disabled = disabled || !hasConflicts || this._deleted;
    this._next.disabled = this._previous.disabled;
    this._baseToggle.disabled = !this._ready || !this._data;
    this._deleteInput.disabled = disabled;
    this._complete.disabled = disabled || (!this._deleted && this._hasMarkers);
    this._conflictSelect.disabled = disabled;
    for (const button of this._choiceButtons) button.disabled = disabled;
    for (const name of ['ours', 'theirs']) this._panes[name].use.disabled = disabled;
    this._panes.result.editor?.updateOptions({ readOnly: disabled || this._deleted, domReadOnly: disabled || this._deleted });
    this._root.classList.toggle('is-deleted', this._deleted);
    this._root.classList.toggle('is-busy', this._busy);
  }

  _update() {
    const parsed = parseConflicts(this.getContent());
    this._conflicts = parsed.conflicts;
    this._hasMarkers = parsed.hasMarkers;
    const activeIndex = Math.min(Number(this._conflictSelect.value) || 0, Math.max(0, this._conflicts.length - 1));
    this._conflictSelect.replaceChildren(...this._conflicts.map((conflict, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = this._t('conflict', { count: index + 1 });
      return option;
    }));
    this._conflictSelect.value = String(activeIndex);
    this._resolveToolbar.hidden = !this._conflicts.length || this._deleted || this._resolved;
    this._choiceButtons[3].hidden = this._conflicts[activeIndex]?.base == null;
    this._status.textContent = this._t(this._resolved ? 'resolved' : this._deleted ? 'deleting' : this._hasMarkers ? (this._conflicts.length ? 'remaining' : 'markers_remain') : 'ready', { count: this._conflicts.length });
    this._updateControls();
    const result = this._panes.result;
    result.editor.changeViewZones(accessor => {
      for (const zone of this._zones) accessor.removeZone(zone);
      this._zones = [];
      if (this._resolved || this._deleted) return;
      this._conflicts.forEach((conflict, index) => {
        const node = document.createElement('div');
        node.className = 'ide-merge-conflict-actions';
        node.addEventListener('mousedown', event => event.stopPropagation());
        node.addEventListener('pointerdown', event => event.stopPropagation());
        const title = document.createElement('strong');
        title.textContent = this._t('conflict', { count: index + 1 });
        node.append(title);
        for (const choice of ['ours', 'theirs', 'both']) {
          node.append(this._button(this._t(`accept_${choice}`), () => this._accept(conflict, choice)));
        }
        if (conflict.base !== null) node.append(this._button(this._t('accept_base'), () => this._accept(conflict, 'base')));
        this._zones.push(accessor.addZone({ afterLineNumber: conflict.startLine - 1, heightInPx: 32, domNode: node, suppressMouseDown: true }));
      });
    });
    const decorations = this._conflicts.map(conflict => ({
      range: new this._monaco.Range(conflict.startLine, 1, conflict.endLine, 1),
      options: { isWholeLine: true, className: 'ide-merge-conflict-line', linesDecorationsClassName: 'ide-merge-conflict-gutter' },
    }));
    result.decorations = result.editor.deltaDecorations(result.decorations || [], this._deleted ? [] : decorations);
    this._sourcePositions = new Map(this._conflicts.map(conflict => [conflict, {}]));
    for (const name of ['ours', 'theirs', 'base']) {
      const pane = this._panes[name];
      let offset = 0;
      const sourceDecorations = [];
      const source = pane.model.getValue().replace(/\r\n/g, '\n');
      for (const conflict of this._conflicts) {
        const chunk = conflict[name]?.replace(/\r\n/g, '\n');
        if (!chunk) continue;
        const found = source.indexOf(chunk, offset);
        // Repeated snippets are ambiguous; never highlight an unrelated source block.
        if (found < 0 || source.indexOf(chunk, found + 1) >= 0) continue;
        const startLine = source.slice(0, found).split('\n').length;
        const endLine = startLine + chunk.replace(/\n$/, '').split('\n').length - 1;
        this._sourcePositions.get(conflict)[name] = startLine;
        sourceDecorations.push({
          range: new this._monaco.Range(startLine, 1, endLine, 1),
          options: { isWholeLine: true, className: 'ide-merge-source-line', linesDecorationsClassName: 'ide-merge-source-gutter' },
        });
        offset = found + chunk.length;
      }
      pane.decorations = pane.editor.deltaDecorations(pane.decorations || [], sourceDecorations);
    }
  }

  _accept(conflict, choice) {
    if (this._busy || this._resolved || this._deleted) return;
    const current = this._conflicts.find(item => item.start === conflict.start && item.end === conflict.end);
    if (current !== conflict) return;
    const text = choice === 'both' ? conflict.ours + conflict.theirs : conflict[choice];
    this._edit(conflict.start, conflict.end, text);
  }

  _edit(start, end, text) {
    const { editor, model } = this._panes.result;
    const from = model.getPositionAt(start);
    const to = model.getPositionAt(end);
    editor.pushUndoStop();
    editor.executeEdits('merge-choice', [{ range: new this._monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text }]);
    editor.pushUndoStop();
    editor.focus();
  }

  _useFile(name) {
    if (!window.confirm(this._t('replace_confirm', { side: this._t(name) }))) return;
    this._deleted = !this._data[name].exists;
    this._deleteInput.checked = this._deleted;
    this._edit(0, this.getContent().length, this._data[name].content);
    this._update();
    this._bus.emit('change', this);
  }

  _navigate(direction) {
    const line = this._panes.result.editor.getPosition()?.lineNumber || 1;
    const conflicts = direction > 0 ? this._conflicts : [...this._conflicts].reverse();
    const next = conflicts.find(conflict => direction > 0 ? conflict.startLine > line : conflict.startLine < line) || conflicts[0];
    if (next) this._reveal(next);
  }

  _reveal(conflict) {
    this._conflictSelect.value = String(this._conflicts.indexOf(conflict));
    this._choiceButtons[3].hidden = conflict.base === null;
    const result = this._panes.result;
    result.editor.setPosition({ lineNumber: conflict.startLine, column: 1 });
    result.editor.revealLineInCenter(conflict.startLine);
    for (const name of ['ours', 'theirs', 'base']) {
      const pane = this._panes[name];
      const line = this._sourcePositions.get(conflict)?.[name];
      if (line) pane.editor.revealLineInCenter(line);
    }
  }

  async beforeSave() {
    await this._initializing;
    if (!this._data) throw new Error(this._t('loading'));
    if (this._resolved) throw new Error(this._t('already_resolved'));
  }

  getSavePayload() { return { content: this._panes.result.model?.getValue(undefined, true) ?? null, deleted: this._deleted }; }

  async saveSnapshot(snapshot) {
    if (snapshot.completeMerge && !snapshot.deleted && parseConflicts(snapshot.content).hasMarkers) {
      throw new Error(this._t('markers_remain'));
    }
    this._busy = true;
    this._updateControls();
    try {
      const response = await this.ctx.api.put('/git/conflict', {
        path: snapshot.path, content: snapshot.content, token: this._token,
        deleted: snapshot.deleted, complete: snapshot.completeMerge,
      });
      this._token = response.token;
      this._resolved = response.resolved;
    } finally {
      this._busy = false;
      this._update();
    }
  }

  getContent() { return this._panes.result.model?.getValue() ?? null; }
  isDirty() { return this._ready && this._saved !== null && (this.getSavePayload().content !== this._saved || this._deleted !== this._savedDeleted); }
  markClean(snapshot) {
    this._saved = snapshot.content;
    this._savedDeleted = snapshot.deleted;
    this._bus.emit('clean', this);
  }
  on(event, listener) { return this._bus.on(event, listener); }
  focus() { this._panes.result.editor?.focus(); }
  resize() { for (const pane of Object.values(this._panes)) pane.editor?.layout(); }

  destroy() {
    this._destroyed = true;
    this._themeObserver?.disconnect();
    this._contentChangeHandler?.dispose();
    this._detachSplitter();
    for (const disposable of this._disposables) disposable.dispose();
    for (const pane of Object.values(this._panes)) {
      pane.editor?.setModel(null);
      pane.editor?.dispose();
      pane.model?.dispose();
    }
    this.host.replaceChildren();
  }
}

export const mergeEditorDescriptor = {
  id: 'codiware.merge',
  label: 'Merge',
  priority: 100,
  accepts: () => false,
  create: (host, ctx) => new MergeEditor(host, ctx),
};
