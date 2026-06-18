import { EventBus } from '../core/EventBus.js';
import { OutlinePanel } from './OutlinePanel.js';
import { loadMonaco } from './monacoLoader.js';

/**
 * Monaco-based code editor. Acts as the default editor for any non-binary
 * file. The Monaco distribution is loaded on-demand from the vendor asset
 * folder (`vendor/npm-asset/monaco-editor/min/vs`) using its built-in AMD
 * loader. The loader is registered once per page and reused across tabs.
 *
 * The wrapper exposes the standard Codiware editor contract:
 *   load(content, meta), getContent(), isDirty(), markClean(),
 *   on(event, fn), destroy().
 *
 * Includes an integrated outline panel on the right side showing document
 * symbols (classes, methods, functions) for quick navigation.
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

function detectLanguage(path) {
  if (!path) return 'plaintext';
  const name = path.split('/').pop() || '';
  if (name === 'composer.json' || name === 'package.json') return 'json';
  if (name === 'Dockerfile') return 'dockerfile';
  if (name.startsWith('.')) return 'plaintext';
  const ext = (name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
  return LANGUAGE_MAP[ext] || 'plaintext';
}

export class MonacoEditor {
  constructor(host, ctx) {
    this.host = host;
    this.ctx = ctx;
    this._bus = new EventBus();
    this._dirty = false;
    this._loadingSuppressed = false; // Suppress dirty flag during content load
    this._pendingContent = '';
    this._pendingMeta = null;
    this._originalEol = null; // Preserve original line endings
    this._editor = null;
    this._model = null;
    this._gotoUnsub = null;
    this._outlinePanel = null;

    host.innerHTML = '';
    host.style.position = 'relative';
    host.style.height = '100%';

    // Create split layout: Monaco editor (left) + Outline panel (right)
    this._wrapper = document.createElement('div');
    this._wrapper.className = 'monaco-editor-wrapper';
    this._wrapper.style.cssText = 'position: absolute; inset: 0; display: flex;';
    host.appendChild(this._wrapper);

    // Monaco editor container
    this._container = document.createElement('div');
    this._container.className = 'monaco-editor-container';
    this._container.style.cssText = 'flex: 1; min-width: 0; position: relative;';
    this._wrapper.appendChild(this._container);

    // Outline panel container
    this._outlineContainer = document.createElement('div');
    this._outlineContainer.className = 'monaco-outline-container';
    this._wrapper.appendChild(this._outlineContainer);

    this._loading = document.createElement('div');
    this._loading.className = 'ide-loading';
    this._loading.textContent = (ctx?.i18n?.t('editor.loading')) || 'Loading editor…';
    this._loading.style.position = 'absolute';
    this._loading.style.inset = '0';
    this._loading.style.display = 'flex';
    this._loading.style.alignItems = 'center';
    this._loading.style.justifyContent = 'center';
    this._loading.style.opacity = '0.7';
    host.appendChild(this._loading);

    this._init().catch((e) => {
      this._loading.textContent = 'Failed to load editor: ' + (e?.message || e);
      this._loading.style.color = 'var(--ide-danger, #c0392b)';
      console.error('[codiware] Monaco load failed:', e);
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
      value: this._pendingContent || '',
      language: detectLanguage(this._pendingMeta?.path),
      automaticLayout: true,
      tabSize: (this.ctx?.editor?.tab_size) || 4,
      insertSpaces: true,
      wordWrap: this.ctx?.editor?.word_wrap ? 'on' : 'off',
      minimap: { enabled: false }, // Disabled - using outline panel instead
      scrollBeyondLastLine: false,
      fontSize: 13,
      renderWhitespace: 'selection',
    };

    this._loadingSuppressed = true; // Suppress change events during editor creation
    this._editor = monaco.editor.create(this._container, editorOpts);
    this._model = this._editor.getModel();

    // Set EOL to match original file if content was loaded before init
    if (this._originalEol && this._model) {
      const eolSeq = this._originalEol === '\r\n'
        ? monaco.editor.EndOfLineSequence.CRLF
        : monaco.editor.EndOfLineSequence.LF;
      this._model.setEOL(eolSeq);
    }

    this._editor.onDidChangeModelContent(() => {
      if (this._loadingSuppressed) return; // Ignore changes during load
      this._dirty = true;
      this._bus.emit('change', this);
    });

    // Scope the save shortcut to this editor instance. Using `addCommand`
    // registers the keybinding on Monaco's shared keybinding service, so with
    // multiple open editors only the last-registered command fires regardless
    // of focus. `onKeyDown` is per-instance and routes to the focused tab.
    this._editor.onKeyDown((e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.keyCode === monaco.KeyCode.KeyS) {
        e.preventDefault();
        e.stopPropagation();
        this._bus.emit('save-request', this);
      }
    });

    // Listen for goto-line requests dispatched by the search panel.
    if (this.ctx?.bus) {
      this._gotoUnsub = this.ctx.bus.on('editor:goto', (payload) => {
        if (!payload || !this._editor) return;
        if (this._pendingMeta && payload.path && payload.path !== this._pendingMeta.path) return;
        if (typeof payload.line === 'number' && payload.line > 0) {
          this._editor.revealLineInCenter(payload.line);
          this._editor.setPosition({ lineNumber: payload.line, column: payload.column || 1 });
          this._editor.focus();
        }
      });
    }

    // Initialize outline panel for symbol navigation
    this._outlinePanel = new OutlinePanel({
      container: this._outlineContainer,
      i18n: this.ctx?.i18n,
    });
    this._outlinePanel.attach(this._editor, monaco);

    this._loading.remove();
    this._loading = null;
    this._loadingSuppressed = false;
    this._dirty = false;
  }

  _applyTheme() {
    if (!this._monaco) return;
    const isDark = document.documentElement.dataset.theme === 'dark';
    this._monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs');
  }

  load(content, meta) {
    const str = String(content ?? '');
    // Detect original line endings (CRLF or LF) from the content
    const hasCRLF = str.includes('\r\n');
    this._originalEol = hasCRLF ? '\r\n' : '\n';
    this._pendingContent = str;
    this._pendingMeta = meta || null;
    
    if (this._editor) {
      // Suppress change events during load to prevent false dirty state
      this._loadingSuppressed = true;
      this._editor.setValue(str);
      // Set the model's EOL to match the original file
      if (this._monaco && this._model) {
        const eolSeq = hasCRLF 
          ? this._monaco.editor.EndOfLineSequence.CRLF 
          : this._monaco.editor.EndOfLineSequence.LF;
        this._model.setEOL(eolSeq);
      }
      if (this._monaco && meta?.path) {
        this._monaco.editor.setModelLanguage(this._editor.getModel(), detectLanguage(meta.path));
      }
      this._loadingSuppressed = false;
    }
    this._dirty = false;
  }

  getContent() {
    if (this._editor) {
      // Get content with the original EOL preserved
      const eolOption = this._originalEol === '\r\n' 
        ? this._monaco.editor.EndOfLinePreference.CRLF 
        : this._monaco.editor.EndOfLinePreference.LF;
      return this._editor.getValue(eolOption);
    }
    return this._pendingContent;
  }

  isDirty() { return this._dirty; }

  /**
   * Move keyboard focus into the Monaco editor. No-op while Monaco is still
   * loading. Called when the owning tab is activated so editor shortcuts work.
   */
  focus() {
    this._editor?.focus();
  }

  markClean() {
    this._dirty = false;
    this._bus.emit('clean', this);
  }

  on(ev, fn) { return this._bus.on(ev, fn); }

  destroy() {
    try { this._gotoUnsub?.(); } catch {}
    try { this._themeObserver?.disconnect(); } catch {}
    try { this._outlinePanel?.dispose(); } catch {}
    try { this._editor?.dispose(); } catch {}
    this._editor = null;
    this._model = null;
    this._outlinePanel = null;
    this.host.innerHTML = '';
  }
}

export const monacoEditorDescriptor = {
  id: 'codiware.monaco',
  label: 'Code',
  priority: 0,
  accepts: () => true, // default editor for any non-binary file
  create: (host, ctx) => new MonacoEditor(host, ctx),
};