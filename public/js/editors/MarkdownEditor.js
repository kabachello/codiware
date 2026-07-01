/**
 * Markdown editor using Toast UI Editor.
 * Provides a rich WYSIWYG editing experience with split markdown/preview modes.
 */

let toastUiEditorCtorPromise = null;
const loadedClassicToastUiSources = new Set();
// Tracks preview CSS hrefs already injected into the document head so multiple
// markdown editor instances do not add duplicate <link> elements.
const injectedPreviewCss = new Set();

function resolveAssetUrl(path, fallbackBase) {
  if (!path) return path;
  if (/^(https?:)?\/\//i.test(path) || path.startsWith('/')) return path;
  const base = (window.CODIWARE_BOOT?.url_base || fallbackBase || '').replace(/\/$/, '');
  return `${base}/${path.replace(/^\//, '')}`;
}

function withCacheBust(url) {
  if (!url) return url;
  const version = window.CODIWARE_BOOT?.cache_bust || '';
  if (!version) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}v=${encodeURIComponent(version)}`;
}

/**
 * Resolve a path that is defined relative to the Composer `vendor` folder
 * (e.g. `npm-asset/github-markdown-css/github-markdown.css`) into an absolute
 * URL. Absolute URLs and root-relative paths are returned unchanged.
 *
 * The vendor folder URL is derived from `url_to_npm` (default
 * `/vendor/npm-asset`) by dropping its last segment (`/npm-asset`).
 */
function resolveVendorUrl(path) {
  if (!path) return path;
  if (/^(https?:)?\/\//i.test(path) || path.startsWith('/')) return path;
  const boot = window.CODIWARE_BOOT || {};
  const base = (boot.url_base || '').replace(/\/$/, '');
  const npm = (boot.url_to_npm || '/vendor/npm-asset').replace(/\/$/, '');
  const vendor = npm.replace(/\/[^/]+$/, '');
  return `${base}${vendor}/${path.replace(/^\//, '')}`;
}

/**
 * Inject one or more stylesheets configured via the markdown extension's
 * `INCLUDES.PREVIEW_CSS` option. Paths are relative to the vendor folder.
 * Injection happens once per resolved href, regardless of editor instances.
 */
function injectPreviewCss(paths) {
  const list = Array.isArray(paths) ? paths : (paths ? [paths] : []);
  for (const path of list) {
    const hrefRaw = resolveVendorUrl(typeof path === 'string' ? path.trim() : '');
    const href = withCacheBust(hrefRaw);
    if (!href || injectedPreviewCss.has(href)) continue;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.codiwareMarkdownCss = '1';
    document.head.appendChild(link);
    injectedPreviewCss.add(href);
  }
}


function extractEditorCtor(mod) {
  const candidates = [
    mod,
    mod?.default,
    mod?.Editor,
    mod?.default?.Editor,
    window.toastui?.Editor,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'function') return candidate;
  }
  return null;
}

// Caches the promise that loads the Mermaid diagram library so it is fetched
// at most once, regardless of how many markdown editor instances exist.
let mermaidPromise = null;

/**
 * Load a global (IIFE) script by appending a <script> tag, resolving once it
 * has executed. Deduplicates by src so the same file is never added twice.
 */
function loadScriptTag(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-codiware-script="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') resolve();
      else existing.addEventListener('load', () => resolve());
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.dataset.codiwareScript = src;
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = () => reject(new Error('Failed to load script: ' + src));
    document.head.appendChild(s);
  });
}

/**
 * Load the Mermaid diagram library from the path configured via the markdown
 * extension's `INCLUDES.MERMAID_JS` option and resolve to the global `mermaid`
 * object. Resolves to `null` when no path is configured or the global is not
 * exposed, so callers can silently skip diagram rendering.
 */
function loadMermaid() {
  if (mermaidPromise) return mermaidPromise;
  const configured = window.CODIWARE_BOOT?.extensions?.['codiware.markdown']?.['INCLUDES.MERMAID_JS'];
  if (!configured) return Promise.resolve(null);
  const assetBase = window.CODIWARE_ASSET_BASE_NPM || '/codiware/assets';
  const src = withCacheBust(resolveAssetUrl(configured, assetBase));
  mermaidPromise = (async () => {
    if (window.mermaid) return window.mermaid;
    await loadScriptTag(src);
    return window.mermaid || null;
  })().catch((e) => {
    console.warn('Codiware: failed to load Mermaid library', e);
    return null;
  });
  return mermaidPromise;
}

function loadClassicScript(src) {
  if (window.toastui?.Editor) return Promise.resolve();
  if (loadedClassicToastUiSources.has(src)) return Promise.resolve();

  return fetch(src)
    .then((res) => {
      if (!res.ok) {
        throw new Error('Failed to load Toast UI script: ' + src + ' (' + res.status + ')');
      }
      return res.text();
    })
    .then((code) => {
      // Evaluate in function scope with local define/exports/module shadows so
      // UMD picks the global branch without mutating window.define.
      const evaluator = new Function(
        'window',
        'self',
        'globalThis',
        `${"var define, exports, module;\n"}${code}\n//# sourceURL=${src}`
      );
      evaluator.call(window, window, window, window);
      loadedClassicToastUiSources.add(src);
    });
}

async function loadToastUiEditorCtor() {
  if (toastUiEditorCtorPromise) return toastUiEditorCtorPromise;

  toastUiEditorCtorPromise = (async () => {
    const assetBase = window.CODIWARE_ASSET_BASE_NPM || '/codiware/assets';
    const includeRaw = window.CODIWARE_BOOT?.extensions?.['codiware.markdown']?.['INCLUDES.EDITOR_JS'] || assetBase + '/toast-ui--editor/dist/esm/index.js';
    const include = withCacheBust(resolveAssetUrl(includeRaw, assetBase));

    if (window.toastui?.Editor) return window.toastui.Editor;

    const looksLikeUmd = /toastui-editor-all\.min\.js(?:\?.*)?$/i.test(include) || /(?:^|\/)umd(?:\/|$)/i.test(include);
    if (looksLikeUmd) {
      await loadClassicScript(include);
      const ctor = extractEditorCtor(null);
      if (!ctor) {
        throw new Error('Failed to initialize Toast UI editor: UMD global not found after script load');
      }
      return ctor;
    }

    const mod = await import(include);
    const ctor = extractEditorCtor(mod);
    if (!ctor) {
      throw new Error('Failed to initialize Toast UI editor: editor export not found');
    }
    return ctor;
  })();

  return toastUiEditorCtorPromise;
}

export class MarkdownEditor {
  constructor(host, ctx) {
    this.host = host;
    this.ctx = ctx;
    this.editor = null;
    this.editorEl = null;
    this.originalContent = '';
    this.listeners = { change: [], 'save-request': [] };
    this._themeObserver = null;
    this._previewObserver = null;
    // True while content is being loaded programmatically, used to suppress
    // the synthetic change event Toast UI fires during setMarkdown().
    this._loading = false;
    // Directory of the currently loaded markdown file, used to resolve
    // relative image sources in the preview pane. Set in load().
    this._currentDir = '';
    this._initPromise = this._init();
  }

  /**
   * Whether a src/href is relative to the markdown file (i.e. should be
   * rewritten). Absolute URLs, data/blob URIs, fragments and root-relative
   * paths are left untouched.
   */
  _isRelativeSrc(src) {
    return !!src && !/^(https?:|data:|blob:|#|\/)/i.test(src);
  }

  /**
   * Resolve a relative path (image src or link href) against the current
   * markdown file's directory, collapsing `.` and `..` segments. Returns the
   * workspace-relative path (no URL, no query). Absolute/non-relative inputs
   * are returned unchanged.
   */
  _resolvePath(src) {
    if (!this._isRelativeSrc(src)) return src;
    const parts = this._currentDir ? this._currentDir.split('/') : [];
    for (const seg of src.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.' && seg !== '') parts.push(seg);
    }
    return parts.join('/');
  }

  /**
   * Resolve a relative image source against the current markdown file's
   * directory and turn it into an absolute URL served by the existing
   * `/files/download` route (which is path-guarded server-side and auto
   * appends the `?root=` of the active workspace).
   */
  _resolveSrc(src) {
    if (!this._isRelativeSrc(src)) return src;
    const resolved = this._resolvePath(src);
    return this.ctx?.api?.url?.('/files/download', { path: resolved }) ?? src;
  }

  /**
   * Rewrite relative `src` of every image in the preview pane. Covers raw
   * `<img>` tags embedded in the markdown, which the customHTMLRenderer does
   * not handle.
   */
  _rewritePreviewImages() {
    if (!this.editorEl) return;
    const preview = this.editorEl.querySelector('.toastui-editor-md-preview .toastui-editor-contents');
    if (!preview) return;
    preview.querySelectorAll('img[src]').forEach((img) => {
      const raw = img.getAttribute('src') || '';
      if (this._isRelativeSrc(raw)) {
        img.src = this._resolveSrc(raw);
      }
    });
  }

  /**
   * Render Mermaid diagrams found in the preview pane. Toast UI outputs fenced
   * ```mermaid code blocks as `<code data-language="mermaid">` elements; those
   * that have not been processed yet are turned into SVG diagrams. No-op when
   * the Mermaid library is not loaded (i.e. no `INCLUDES.MERMAID_JS` path is
   * configured).
   */
  _refreshMermaid() {
    const mermaid = window.mermaid;
    if (!mermaid || !this.editorEl) return;
    const nodes = this.editorEl.querySelectorAll(
      '.toastui-editor-md-preview code[data-language="mermaid"]:not([data-processed])'
    );
    if (nodes.length === 0) return;
    try {
      const isDark = document.documentElement.dataset.theme === 'dark';
      mermaid.initialize({ startOnLoad: false, theme: isDark ? 'dark' : 'default' });
      mermaid.run({ nodes: Array.from(nodes) });
    } catch (e) {
      console.warn('Codiware: failed to render Mermaid diagram', e);
    }
  }

  async _init() {
    const host = this.host;
    host.innerHTML = '';
    host.style.display = 'flex';
    host.style.flexDirection = 'column';
    host.style.background = 'var(--ide-bg)';
    host.style.minHeight = '0';
    host.style.overflow = 'hidden';

    // Inject any preview stylesheets configured for this extension. Paths are
    // defined relative to the vendor folder (e.g. for github-markdown-css).
    injectPreviewCss(window.CODIWARE_BOOT?.extensions?.['codiware.markdown']?.['INCLUDES.PREVIEW_CSS']);

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

    const Editor = await loadToastUiEditorCtor();

    // Detect dark mode
    const isDark = document.documentElement.dataset.theme === 'dark';

    const editorOptions = {
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
      // Rewrite relative image sources (markdown `![]()` syntax) so they
      // resolve against the markdown file's directory instead of the page URL.
      customHTMLRenderer: {
        image: (node, context) => {
          const { destination } = node;
          const { getChildrenText, skipChildren } = context;
          skipChildren();
          return {
            type: 'openTag',
            tagName: 'img',
            selfClose: true,
            attributes: {
              src: this._resolveSrc(destination),
              alt: getChildrenText(node),
            },
          };
        },
      },
    };

    this.editor = typeof Editor.factory === 'function'
      ? Editor.factory(editorOptions)
      : new Editor(editorOptions);

    // Wire up change events. Suppress the synthetic change Toast UI fires while
    // content is being loaded programmatically, otherwise the owning tab would
    // read isDirty() before the baseline is set and flag a false dirty state.
    this.editor.on('change', () => {
      if (this._loading) return;
      this._emit('change');
    });

    // Handle Ctrl+S save request.
    // Use the capture phase and stop propagation so the event never reaches
    // Toast UI's underlying ProseMirror keymap, which otherwise binds Ctrl+S
    // to insert a code block (`~~~~`) at the caret.
    this.editorEl.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();
        this._emit('save-request');
      }
    }, true);

    // Observe theme changes
    this._themeObserver = new MutationObserver(() => this._applyTheme());
    this._themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    // Rewrite relative image sources in the preview pane whenever it updates.
    // Covers raw <img> tags that the customHTMLRenderer does not handle.
    const preview = this.editorEl.querySelector('.toastui-editor-md-preview .toastui-editor-contents');
    if (preview) {
      // Add any configured class(es) so stylesheets scoped to them (e.g.
      // `markdown-body` for github-markdown-css included via
      // INCLUDES.PREVIEW_CSS) apply to the rendered preview.
      const previewClass = window.CODIWARE_BOOT?.extensions?.['codiware.markdown']?.['CSS_CLASS_FOR_PREVIEW_CONTAINER'];
      if (previewClass) {
        for (const cls of String(previewClass).split(/\s+/)) {
          if (cls) preview.classList.add(cls);
        }
      }
      this._previewObserver = new MutationObserver(() => {
        this._rewritePreviewImages();
        this._refreshMermaid();
      });
      this._previewObserver.observe(preview, { childList: true, subtree: true });

      // Open relative markdown links (`[](path)`) in an editor instead of
      // navigating the page. Absolute URLs and in-page anchors are left alone.
      preview.addEventListener('click', (e) => this._onPreviewClick(e));
    }

    // Load the Mermaid library (if configured) and render any diagrams already
    // present in the initial preview.
    loadMermaid().then(() => this._refreshMermaid());
  }

  /**
   * Intercept clicks on relative links in the preview and open the target file
   * in an editor tab via the public Codiware API.
   */
  _onPreviewClick(e) {
    const anchor = e.target.closest?.('a[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    if (!this._isRelativeSrc(href)) return;
    e.preventDefault();
    // Strip any in-page fragment before resolving to a file path.
    const path = this._resolvePath(href.replace(/#.*$/, ''));
    if (!path) return;
    window.Codiware?.openFile?.({ path, name: path.split('/').pop() });
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
    // Directory of the markdown file (without trailing slash), used to resolve
    // relative image sources in the preview pane.
    this._currentDir = (meta?.path || '').replace(/\/?[^/]*$/, '');
    this._loading = true;
    this.editor.setMarkdown(content || '', false);
    // Baseline against the editor's own serialization rather than the raw file
    // string. Toast UI normalizes markdown on load (e.g. image/link syntax),
    // so comparing getMarkdown() to the raw content would report a false
    // "dirty" state even though the user has not edited anything.
    this.originalContent = this.editor.getMarkdown();
    this._loading = false;
    this._rewritePreviewImages();
    this._refreshMermaid();
    // Let the owning tab re-evaluate isDirty() now that the baseline is set,
    // clearing any dirty state from the programmatic load above.
    this._emit('change');
  }

  getContent() {
    return this.editor ? this.editor.getMarkdown() : this.originalContent;
  }

  isDirty() {
    return this.getContent() !== this.originalContent;
  }

  /**
   * Move keyboard focus into the editor. No-op while Toast UI is still
   * initialising. Called when the owning tab is activated so the editor's
   * Ctrl+S keydown listener targets this document instead of the sidebar.
   */
  focus() {
    this.editor?.focus?.();
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
    if (this._previewObserver) {
      this._previewObserver.disconnect();
      this._previewObserver = null;
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