import { EventBus } from '../core/EventBus.js';

/**
 * Monaco-based diff editor for viewing git changes.
 * Uses Monaco's side-by-side diff view to show original vs modified content.
 * Includes inline revert buttons for each change block.
 *
 * The wrapper exposes a simplified contract:
 *   load({ original, modified, path, staged }), getContent(), isDirty(), destroy()
 *
 * The modified side is editable to allow reverting individual blocks.
 */

const LANGUAGE_MAP = {
  php: 'php', phtml: 'php',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  json: 'json',
  html: 'html', htm: 'html',
  xml: 'xml', xsd: 'xml', xsl: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown',
  sql: 'sql',
  yml: 'yaml', yaml: 'yaml',
  sh: 'shell', bash: 'shell',
  py: 'python',
  rb: 'ruby',
  java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  ini: 'ini', conf: 'ini',
  twig: 'html',
  vue: 'html',
  txt: 'plaintext', log: 'plaintext',
};

let monacoPromise = null;

/**
 * Load the Monaco AMD distribution once and resolve with the global `monaco`
 * namespace. Reuses the same promise as MonacoEditor.
 */
function loadMonaco() {
  if (monacoPromise) return monacoPromise;
  monacoPromise = new Promise((resolve, reject) => {
    const base = (window.CODIWARE_ASSET_BASE || '') + '/monaco/node_modules/monaco-editor/min/vs';

    const previousRequire = window.require;
    const previousDefine = window.define;

    const loader = document.createElement('script');
    loader.src = base + '/loader.js';
    loader.async = true;
    loader.onload = () => {
      try {
        window.require.config({ paths: { vs: base } });
        window.MonacoEnvironment = window.MonacoEnvironment || {
          getWorkerUrl: function (_moduleId, _label) {
            const proxy = URL.createObjectURL(new Blob([
              `self.MonacoEnvironment = { baseUrl: '${base}/' };`,
              `importScripts('${base}/base/worker/workerMain.js');`,
            ], { type: 'text/javascript' }));
            return proxy;
          },
        };
        window.require(['vs/editor/editor.main'], () => {
          const monaco = window.monaco;
          if (previousDefine !== undefined) window.define = previousDefine;
          if (previousRequire !== undefined) window.require = previousRequire;
          resolve(monaco);
        }, (err) => reject(err));
      } catch (e) {
        reject(e);
      }
    };
    loader.onerror = () => reject(new Error('Failed to load Monaco loader from ' + loader.src));
    document.head.appendChild(loader);
  });
  return monacoPromise;
}

function detectLanguage(path) {
  if (!path) return 'plaintext';
  const name = path.split('/').pop() || '';
  if (name === 'composer.json' || name === 'package.json') return 'json';
  if (name === 'Dockerfile') return 'dockerfile';
  if (name.startsWith('.')) return 'plaintext';
  const ext = (name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
  return LANGUAGE_MAP[ext] || 'plaintext';
}

export class DiffEditor {
  constructor(host, ctx) {
    this.host = host;
    this.ctx = ctx;
    this._bus = new EventBus();
    this._editor = null;
    this._originalModel = null;
    this._modifiedModel = null;
    this._pendingData = null;
    this._dirty = false;
    this._originalContent = '';
    this._path = null;
    this._revertWidgets = [];
    this._diffUpdateTimeout = null;

    host.innerHTML = '';
    host.style.position = 'relative';
    host.style.height = '100%';

    this._container = document.createElement('div');
    this._container.style.cssText = 'position: absolute; inset: 0;';
    host.appendChild(this._container);

    this._loading = document.createElement('div');
    this._loading.className = 'ide-loading';
    this._loading.textContent = (ctx?.i18n?.t('editor.loading')) || 'Loading diff editor…';
    this._loading.style.position = 'absolute';
    this._loading.style.inset = '0';
    this._loading.style.display = 'flex';
    this._loading.style.alignItems = 'center';
    this._loading.style.justifyContent = 'center';
    this._loading.style.opacity = '0.7';
    host.appendChild(this._loading);

    this._init().catch((e) => {
      this._loading.textContent = 'Failed to load diff editor: ' + (e?.message || e);
      this._loading.style.color = 'var(--ide-danger, #c0392b)';
      console.error('[codiware] Monaco diff load failed:', e);
    });
  }

  async _init() {
    const monaco = await loadMonaco();
    this._monaco = monaco;

    // React to global theme changes.
    this._applyTheme();
    this._themeObserver = new MutationObserver(() => this._applyTheme());
    this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    const editorOpts = {
      automaticLayout: true,
      readOnly: false, // Allow editing to enable revert
      renderSideBySide: true,
      scrollBeyondLastLine: false,
      fontSize: 13,
      minimap: { enabled: false },
      renderOverviewRuler: true,
      originalEditable: false, // Original side stays read-only
      glyphMargin: true, // Enable glyph margin for revert buttons
    };

    this._editor = monaco.editor.createDiffEditor(this._container, editorOpts);

    // Apply pending data if any
    if (this._pendingData) {
      this._applyData(this._pendingData);
      this._pendingData = null;
    }

    this._loading.remove();
    this._loading = null;
  }

  _applyTheme() {
    if (!this._monaco) return;
    const isDark = document.documentElement.dataset.theme === 'dark';
    this._monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs');
  }

  _applyData(data) {
    if (!this._editor || !this._monaco) return;

    const language = detectLanguage(data.path);
    this._path = data.path;
    this._originalContent = data.original || '';

    // Dispose old models if they exist
    this._originalModel?.dispose();
    this._modifiedModel?.dispose();

    // Create new models for the diff
    this._originalModel = this._monaco.editor.createModel(
      data.original || '',
      language
    );
    this._modifiedModel = this._monaco.editor.createModel(
      data.modified || '',
      language
    );

    this._editor.setModel({
      original: this._originalModel,
      modified: this._modifiedModel,
    });

    // Listen for changes in the modified model
    this._modifiedModel.onDidChangeContent(() => {
      this._dirty = true;
      this._bus.emit('change', this);
      // Debounce revert button updates
      clearTimeout(this._diffUpdateTimeout);
      this._diffUpdateTimeout = setTimeout(() => this._updateRevertButtons(), 150);
    });

    // Listen for diff computation to complete
    this._editor.onDidUpdateDiff(() => {
      this._updateRevertButtons();
    });

    // Add save shortcut
    const modifiedEditor = this._editor.getModifiedEditor();
    modifiedEditor.addCommand(this._monaco.KeyMod.CtrlCmd | this._monaco.KeyCode.KeyS, () => {
      this._bus.emit('save-request', this);
    });

    this._dirty = false;
  }

  _updateRevertButtons() {
    if (!this._editor || !this._monaco) return;

    const modifiedEditor = this._editor.getModifiedEditor();

    // Clear existing widgets
    this._revertWidgets.forEach(w => w.dispose?.());
    this._revertWidgets = [];

    // Get line changes (diff hunks)
    const lineChanges = this._editor.getLineChanges();
    if (!lineChanges || lineChanges.length === 0) return;

    // Add revert button for each change block
    const decorations = [];
    for (const change of lineChanges) {
      // Skip if this is a pure deletion (no modified lines to show button on)
      if (change.modifiedStartLineNumber > change.modifiedEndLineNumber) {
        // For deletions, show button at the modified start line (insertion point)
        decorations.push({
          range: new this._monaco.Range(change.modifiedStartLineNumber, 1, change.modifiedStartLineNumber, 1),
          options: {
            glyphMarginClassName: 'diff-revert-glyph',
            glyphMarginHoverMessage: { value: this.ctx?.i18n?.t('diff.revert_block') || 'Revert this block' },
          },
        });
      } else {
        // For modifications/additions, show button at the first modified line
        decorations.push({
          range: new this._monaco.Range(change.modifiedStartLineNumber, 1, change.modifiedStartLineNumber, 1),
          options: {
            glyphMarginClassName: 'diff-revert-glyph',
            glyphMarginHoverMessage: { value: this.ctx?.i18n?.t('diff.revert_block') || 'Revert this block' },
          },
        });
      }
    }

    // Apply decorations
    this._decorationIds = modifiedEditor.deltaDecorations(this._decorationIds || [], decorations);

    // Handle clicks on glyph margin
    if (!this._glyphClickHandler) {
      this._glyphClickHandler = modifiedEditor.onMouseDown((e) => {
        if (e.target.type === this._monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
          const lineNumber = e.target.position?.lineNumber;
          if (lineNumber) {
            this._revertBlockAtLine(lineNumber);
          }
        }
      });
    }
  }

  _revertBlockAtLine(lineNumber) {
    const lineChanges = this._editor.getLineChanges();
    if (!lineChanges) return;

    // Find the change that contains this line
    for (const change of lineChanges) {
      const modStart = change.modifiedStartLineNumber;
      const modEnd = change.modifiedEndLineNumber;
      
      // Check if click is on this change's start line
      if (lineNumber === modStart || (modStart > modEnd && lineNumber === modStart)) {
        this._revertChange(change);
        break;
      }
    }
  }

  _revertChange(change) {
    if (!this._modifiedModel || !this._originalModel) return;

    const monaco = this._monaco;
    const modifiedEditor = this._editor.getModifiedEditor();

    // Get the original lines for this block
    const origStart = change.originalStartLineNumber;
    const origEnd = change.originalEndLineNumber;
    const modStart = change.modifiedStartLineNumber;
    const modEnd = change.modifiedEndLineNumber;

    let originalText = '';
    if (origStart <= origEnd) {
      // There are original lines to restore
      originalText = this._originalModel.getValueInRange(
        new monaco.Range(origStart, 1, origEnd, this._originalModel.getLineMaxColumn(origEnd))
      );
    }

    // Determine the range to replace in the modified model
    let replaceRange;
    if (modStart > modEnd) {
      // Pure deletion case: insert at this position
      replaceRange = new monaco.Range(modStart, 1, modStart, 1);
      if (originalText) originalText += '\n';
    } else if (origStart > origEnd) {
      // Pure addition case: delete these lines entirely
      const endCol = modEnd < this._modifiedModel.getLineCount()
        ? 1
        : this._modifiedModel.getLineMaxColumn(modEnd);
      replaceRange = new monaco.Range(modStart, 1, modEnd + (modEnd < this._modifiedModel.getLineCount() ? 1 : 0), endCol);
      originalText = '';
    } else {
      // Modification: replace modified lines with original lines
      replaceRange = new monaco.Range(modStart, 1, modEnd, this._modifiedModel.getLineMaxColumn(modEnd));
    }

    // Apply the edit
    modifiedEditor.executeEdits('revert-block', [{
      range: replaceRange,
      text: originalText,
    }]);

    this._dirty = true;
    this._bus.emit('change', this);
  }

  /**
   * Load diff data into the editor.
   * @param {Object} data - { original: string, modified: string, path: string, staged: boolean }
   */
  load(data) {
    if (this._editor) {
      this._applyData(data);
    } else {
      this._pendingData = data;
    }
  }

  getContent() {
    if (this._modifiedModel) {
      return this._modifiedModel.getValue();
    }
    return null;
  }

  isDirty() { return this._dirty; }

  markClean() {
    this._dirty = false;
    this._bus.emit('clean', this);
  }

  on(ev, fn) { return this._bus.on(ev, fn); }

  destroy() {
    try { this._themeObserver?.disconnect(); } catch {}
    try { this._glyphClickHandler?.dispose(); } catch {}
    // To avoid Monaco error, set model to null before disposing models
    try { this._editor?.setModel(null); } catch {}
    try { this._editor?.dispose(); } catch {}
    try { this._originalModel?.dispose(); } catch {}
    try { this._modifiedModel?.dispose(); } catch {}
    clearTimeout(this._diffUpdateTimeout);
    this._revertWidgets.forEach(w => w.dispose?.());
    this._editor = null;
    this._originalModel = null;
    this._modifiedModel = null;
    this._revertWidgets = [];
    this.host.innerHTML = '';
  }
}

export const diffEditorDescriptor = {
  id: 'codiware.diff',
  label: 'Diff',
  priority: 100, // High priority but only used explicitly
  accepts: () => false, // Never auto-selected; only opened programmatically
  create: (host, ctx) => new DiffEditor(host, ctx),
};
