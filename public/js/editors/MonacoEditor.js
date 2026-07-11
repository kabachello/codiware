import { EventBus } from '../core/EventBus.js';
import { OutlinePanel } from './OutlinePanel.js';
import { loadMonaco } from './monacoLoader.js';
import { attachSplitter } from '../layout/Splitter.js';
import { Icon } from '../core/Icon.js';

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

const OUTLINE_PANEL_DEFAULT_WIDTH = 180;
const OUTLINE_PANEL_MIN_WIDTH = 120;
const OUTLINE_PANEL_MAX_WIDTH = 280;
const OUTLINE_PANEL_STRIP_WIDTH = 36;
const OUTLINE_PANEL_MOBILE_BREAKPOINT = 768;

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
    this._outlineWidth = this._restoreOutlineWidth();
    this._outlineCollapsed = this._restoreOutlineCollapsed();
    this._outlinePanelResponsiveDefaultApplied = false;

    host.innerHTML = '';
    host.style.position = 'relative';
    host.style.height = '100%';

    // Create split layout: Monaco editor (left) + collapsible outline panel (right)
    this._wrapper = document.createElement('div');
    this._wrapper.className = 'monaco-editor-wrapper';
    host.appendChild(this._wrapper);

    // Monaco editor container
    this._container = document.createElement('div');
    this._container.className = 'monaco-editor-container';
    this._wrapper.appendChild(this._container);

    // Outline splitter between editor and side panel
    this._outlineSplitter = document.createElement('div');
    this._outlineSplitter.className = 'ide-splitter monaco-outline-splitter';
    this._wrapper.appendChild(this._outlineSplitter);

    // Outline panel shell
    this._outlineContainer = document.createElement('div');
    this._outlineContainer.className = 'monaco-outline-container ide-sidebar ide-sidebar-right';
    this._wrapper.appendChild(this._outlineContainer);

    this._buildOutlineShell();
    this._applyResponsiveOutlineDefault();
    this._applyOutlinePanelState();
    this._bindOutlineResize();

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

  /**
   * Build the outline side-panel shell around the actual outline content.
   *
   * The shell mirrors the global sidebar tab language: the active tab shows
   * icon + title when expanded, while collapsed mode keeps a visible icon rail
   * with the active marker and collapse toggle.
   */
  _buildOutlineShell() {
    const outlineLabel = this.ctx?.i18n?.t('outline.title') || 'Outline';
    const collapseLabel = this.ctx?.i18n?.t('actions.collapse') || 'Collapse';
    const expandLabel = this.ctx?.i18n?.t('actions.expand') || 'Expand';

    this._outlineTabs = document.createElement('div');
    this._outlineTabs.className = 'ide-sidebar-tabs';

    this._outlineToggleBtn = document.createElement('button');
    this._outlineToggleBtn.type = 'button';
    this._outlineToggleBtn.className = 'ide-sidebar-collapse monaco-outline-toggle';
    this._outlineToggleBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleOutlinePanel();
    });

    this._outlineTabBtn = document.createElement('button');
    this._outlineTabBtn.type = 'button';
    this._outlineTabBtn.className = 'active monaco-outline-tab';
    this._outlineTabBtn.dataset.panel = 'outline';
    this._outlineTabBtn.title = outlineLabel;
    this._outlineTabBtn.setAttribute('aria-label', outlineLabel);
    this._outlineTabBtn.addEventListener('click', () => {
      if (this._outlineCollapsed) {
        this.expandOutlinePanel();
      }
    });

    const tabIcon = document.createElement('span');
    tabIcon.className = 'ide-sidebar-tab-icon';
    tabIcon.append(Icon.render('fa fa-list-alt'));

    const tabLabel = document.createElement('span');
    tabLabel.className = 'ide-sidebar-tab-label';
    tabLabel.textContent = outlineLabel;

    this._outlineTabBtn.append(tabIcon, tabLabel);
    this._outlineTabs.append(this._outlineToggleBtn, this._outlineTabBtn);

    this._outlineContent = document.createElement('div');
    this._outlineContent.className = 'ide-sidebar-content monaco-outline-content';

    this._outlinePanelBody = document.createElement('div');
    this._outlinePanelBody.className = 'monaco-outline-panel-body';
    this._outlineContent.appendChild(this._outlinePanelBody);

    this._outlineContainer.append(this._outlineTabs, this._outlineContent);

    this._outlineLabel = outlineLabel;
    this._outlineCollapseLabel = collapseLabel;
    this._outlineExpandLabel = expandLabel;
    this._updateOutlineToggleButton();
  }

  /**
   * Restore the persisted outline width for the current installation.
   *
   * @returns {number}
   */
  _restoreOutlineWidth() {
    const saved = this.ctx?.settings?.getGlobal?.('editor.monaco.outlineWidth');
    if (typeof saved !== 'number' || !Number.isFinite(saved)) {
      return OUTLINE_PANEL_DEFAULT_WIDTH;
    }
    return Math.max(OUTLINE_PANEL_MIN_WIDTH, Math.min(OUTLINE_PANEL_MAX_WIDTH, saved));
  }

  /**
   * Restore the persisted collapsed state for the outline panel.
   *
   * @returns {boolean}
   */
  _restoreOutlineCollapsed() {
    const saved = this.ctx?.settings?.getGlobal?.('editor.monaco.outlineCollapsed');
    if (typeof saved === 'boolean') {
      return saved;
    }
    return false;
  }

  /**
   * Collapse the outline automatically on narrow screens when no explicit user
   * preference was stored yet.
   */
  _applyResponsiveOutlineDefault() {
    if (this._outlinePanelResponsiveDefaultApplied) return;
    this._outlinePanelResponsiveDefaultApplied = true;

    const saved = this.ctx?.settings?.getGlobal?.('editor.monaco.outlineCollapsed');
    if (typeof saved === 'boolean') return;

    if ((window.innerWidth || 0) <= OUTLINE_PANEL_MOBILE_BREAKPOINT) {
      this._outlineCollapsed = true;
    }
  }

  /**
   * Wire the shared splitter helper to the outline width state.
   */
  _bindOutlineResize() {
    attachSplitter(this._outlineSplitter, {
      orientation: 'vertical',
      onResize: {
        invert: true,
        getSize: () => this._outlineWidth,
        apply: (px) => {
          this._outlineWidth = Math.max(OUTLINE_PANEL_MIN_WIDTH, Math.min(OUTLINE_PANEL_MAX_WIDTH, px));
          this._outlineCollapsed = false;
          this._persistOutlineState();
          this._applyOutlinePanelState();
          this._editor?.layout?.();
        },
      },
    });
  }

  /**
   * Persist the outline width and collapsed state for future editor tabs.
   */
  _persistOutlineState() {
    this.ctx?.settings?.setGlobal?.('editor.monaco.outlineWidth', this._outlineWidth);
    this.ctx?.settings?.setGlobal?.('editor.monaco.outlineCollapsed', this._outlineCollapsed);
  }

  /**
   * Update button labels and icons so the outline shell reflects its state.
   */
  _updateOutlineToggleButton() {
    if (!this._outlineToggleBtn) return;

    const isCollapsed = this._outlineCollapsed === true;
    const actionLabel = isCollapsed ? this._outlineExpandLabel : this._outlineCollapseLabel;
    const fullLabel = `${actionLabel} ${this._outlineLabel}`;

    this._outlineToggleBtn.title = fullLabel;
    this._outlineToggleBtn.setAttribute('aria-label', fullLabel);
    this._outlineToggleBtn.replaceChildren(Icon.render(isCollapsed ? 'fa fa-angle-left' : 'fa fa-angle-right'));
  }

  /**
   * Apply the current outline width/collapsed state to the editor shell.
   */
  _applyOutlinePanelState() {
    const layout = this.ctx?.layout;
    if (layout?.applyEditorSidePanelState) {
      layout.applyEditorSidePanelState({
        shell: this._wrapper,
        panel: this._outlineContainer,
        splitter: this._outlineSplitter,
        panelWidth: this._outlineWidth,
        stripWidth: OUTLINE_PANEL_STRIP_WIDTH,
        collapsed: this._outlineCollapsed,
      });
    } else {
      if (this._outlineCollapsed) {
        this._wrapper.style.gridTemplateColumns = `minmax(0, 1fr) ${OUTLINE_PANEL_STRIP_WIDTH}px`;
        this._outlineSplitter.style.display = 'none';
        this._outlineContainer.classList.add('is-collapsed');
      } else {
        this._wrapper.style.gridTemplateColumns = `minmax(0, 1fr) 5px ${this._outlineWidth}px`;
        this._outlineSplitter.style.display = '';
        this._outlineContainer.classList.remove('is-collapsed');
      }
    }

    this._updateOutlineToggleButton();
  }

  /**
   * Expand the outline side panel and restore its remembered width.
   */
  expandOutlinePanel() {
    this._outlineCollapsed = false;
    this._persistOutlineState();
    this._applyOutlinePanelState();
    this._editor?.layout?.();
  }

  /**
   * Collapse the outline side panel into its narrow icon strip.
   */
  collapseOutlinePanel() {
    this._outlineCollapsed = true;
    this._persistOutlineState();
    this._applyOutlinePanelState();
    this._editor?.layout?.();
  }

  /**
   * Toggle the outline side panel between expanded and collapsed state.
   */
  toggleOutlinePanel() {
    if (this._outlineCollapsed) this.expandOutlinePanel();
    else this.collapseOutlinePanel();
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
      container: this._outlinePanelBody,
      i18n: this.ctx?.i18n,
    });
    this._outlinePanel.attach(this._editor, monaco);

    this._loading.remove();
    this._loading = null;
    this._loadingSuppressed = false;
    this._dirty = false;
    this._applyOutlinePanelState();
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
