/**
 * Markdown editor using Toast UI Editor.
 * Provides a rich WYSIWYG editing experience with split markdown/preview modes.
 */
export class MarkdownEditor {
  constructor(host, ctx) {
    this.host = host;
    this.ctx = ctx;
    this.editor = null;
    this.editorEl = null;
    this.originalContent = '';
    this.listeners = { change: [], 'save-request': [] };
    this._themeObserver = null;
    this._initPromise = this._init();
  }

  async _init() {
    const host = this.host;
    host.innerHTML = '';
    host.style.display = 'flex';
    host.style.flexDirection = 'column';
    host.style.background = 'var(--ide-bg)';
    host.style.minHeight = '0';
    host.style.overflow = 'hidden';

    // Import map for Toast UI Editor's prosemirror dependencies (must be inline, before any module scripts)
    /* TODO this was moved from index, but does not work here. This was neccessary to use the asset-packagist
     * version of TUI Editor, which does not bundle the prosemirror dependencies.
    var im = document.createElement('script');
    var assetsNpm = window.CODIWARE_BOOT.url_to_npm
    im.type = 'importmap';
    im.textContent = '{"imports":{' +
        '"prosemirror-model":"' + assetsNpm + '/prosemirror-model/dist/index.js",' +
        '"prosemirror-view":"' + assetsNpm + '/prosemirror-view/dist/index.js",' +
        '"prosemirror-state":"' + assetsNpm + '/prosemirror-state/dist/index.js",' +
        '"prosemirror-transform":"' + assetsNpm + '/prosemirror-transform/dist/index.js",' +
        '"prosemirror-commands":"' + assetsNpm + '/prosemirror-commands/dist/index.js",' +
        '"prosemirror-history":"' + assetsNpm + '/prosemirror-history/dist/index.js",' +
        '"prosemirror-inputrules":"' + assetsNpm + '/prosemirror-inputrules/dist/index.js",' +
        '"prosemirror-keymap":"' + assetsNpm + '/prosemirror-keymap/dist/index.js",' +
        '"orderedmap":"' + assetsNpm + '/orderedmap/dist/index.js",' +
        '"rope-sequence":"' + assetsNpm + '/rope-sequence/dist/index.js",' +
        '"w3c-keyname":"' + assetsNpm + '/w3c-keyname/index.js"}}';
    document.currentScript.after(im);
    */

    this.editorEl = document.createElement('div');
    this.editorEl.className = 'toastui-editor-wrapper';
    this.editorEl.style.flex = '1';
    this.editorEl.style.minHeight = '0';
    this.editorEl.style.overflow = 'hidden';
    host.appendChild(this.editorEl);

    // Dynamically import Toast UI Editor (ESM bundle has all deps included)
    const assetBase = window.CODIWARE_ASSET_BASE_NPM || '/codiware/assets';
    const { default: Editor } = await import(window.CODIWARE_BOOT?.extensions['codiware.markdown']['INCLUDES.EDITOR_JS'] || assetBase + '/toast-ui--editor/dist/esm/index.js');

    // Detect dark mode
    const isDark = document.documentElement.dataset.theme === 'dark';

    this.editor = toastui.Editor.factory({
      el: this.editorEl,
      height: '100%',
      initialEditType: 'markdown',
      previewStyle: 'vertical',
      usageStatistics: false,
      theme: isDark ? 'dark' : 'light',
      extendedAutolinks: true,
      toolbarItems: [
        ['heading', 'bold', 'italic', 'strike'],
        ['hr', 'quote'],
        ['ul', 'ol', 'task', 'indent', 'outdent'],
        ['table', 'link', 'image'],
        ['code', 'codeblock'],
      ],
    });

    // Wire up change events
    this.editor.on('change', () => {
      this._emit('change');
    });

    // Handle Ctrl+S save request
    this.editorEl.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        this._emit('save-request');
      }
    });

    // Observe theme changes
    this._themeObserver = new MutationObserver(() => this._applyTheme());
    this._themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }

  _applyTheme() {
    if (!this.editorEl) return;
    const isDark = document.documentElement.dataset.theme === 'dark';
    const editorContainer = this.editorEl.querySelector('.toastui-editor-defaultUI');
    if (editorContainer) {
      editorContainer.classList.toggle('toastui-editor-dark', isDark);
    }
  }

  async load(content, meta) {
    await this._initPromise;
    this.originalContent = content || '';
    this.editor.setMarkdown(this.originalContent, false);
  }

  getContent() {
    return this.editor ? this.editor.getMarkdown() : this.originalContent;
  }

  isDirty() {
    return this.getContent() !== this.originalContent;
  }

  markClean() {
    this.originalContent = this.getContent();
  }

  on(ev, fn) {
    if (this.listeners[ev]) {
      this.listeners[ev].push(fn);
    }
    return () => {
      if (this.listeners[ev]) {
        this.listeners[ev] = this.listeners[ev].filter(f => f !== fn);
      }
    };
  }

  _emit(ev) {
    (this.listeners[ev] || []).forEach(fn => fn());
  }

  destroy() {
    if (this._themeObserver) {
      this._themeObserver.disconnect();
      this._themeObserver = null;
    }
    if (this.editor) {
      this.editor.destroy();
      this.editor = null;
    }
    this.editorEl = null;
    this.host.innerHTML = '';
  }
}

export const markdownEditorDescriptor = {
  id: 'codiware.markdown',
  label: 'Markdown',
  priority: 10,
  accepts: (entry) => /\.(md|markdown)$/i.test(entry?.path || ''),
  create: (host, ctx) => new MarkdownEditor(host, ctx),
};