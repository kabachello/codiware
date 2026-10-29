/** Host adapter; Markian owns editing while Codiware owns files and transport. */
const markianAssets = new Map();

function loadMarkianAsset(url, stylesheet = false) {
  if (markianAssets.has(url)) return markianAssets.get(url);
  const promise = new Promise((resolve, reject) => {
    const element = document.createElement(stylesheet ? 'link' : 'script');
    if (stylesheet) { element.rel = 'stylesheet'; element.href = url; }
    else element.src = url;
    element.onload = resolve;
    element.onerror = () => { element.remove(); reject(new Error('Could not load Markian asset: ' + url)); };
    document.head.append(element);
  }).catch(error => { markianAssets.delete(url); throw error; });
  markianAssets.set(url, promise);
  return promise;
}

function resolveAssetUrl(path) {
  if (!path) return path;
  if (/^(https?:)?\/\//i.test(path) || path.startsWith('/')) return path;
  const base = (window.CODIWARE_BOOT?.url_base || '').replace(/\/$/, '');
  return `${base}/${path.replace(/^\//, '')}`;
}

function withCacheBust(url) {
  if (!url) return url;
  const version = window.CODIWARE_BOOT?.cache_bust || '';
  if (!version) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}v=${encodeURIComponent(version)}`;
}

/** Resolve Composer vendor-relative styles without assuming the installation is at the web root. */
function resolveVendorUrl(path) {
  if (!path) return path;
  if (/^(https?:)?\/\//i.test(path) || path.startsWith('/')) return path;
  const boot = window.CODIWARE_BOOT || {};
  const base = (boot.url_base || '').replace(/\/$/, '');
  const npm = (boot.url_to_npm || '/vendor/npm-asset').replace(/\/$/, '');
  const vendor = npm.replace(/\/[^/]+$/, '');
  return `${base}${vendor}/${path.replace(/^\//, '')}`;
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
    this._loading = false;
    this._currentDir = '';
    this._destroyed = false;
    this._generation = 0;
    this._initPromise = this._init();
  }

  async _init() {
    this.settings = window.CODIWARE_BOOT?.extensions?.['codiware.markdown'] || {};
    this.host.replaceChildren();
    this.host.style.height = '100%';
    this.host.style.minHeight = '0';
    const script = resolveAssetUrl(this.settings['INCLUDES.MARKIAN_JS'] || 'vendor/axenox/markian/dist/markian.min.js');
    const base = new URL('.', new URL(script, document.baseURI)).href;
    const asset = (key, file) => withCacheBust(this.settings[key] ? resolveAssetUrl(this.settings[key]) : base + file);
    await Promise.all([
      loadMarkianAsset(withCacheBust(script)),
      loadMarkianAsset(asset('INCLUDES.MARKIAN_CSS', 'markian.css'), true),
    ]);
    if (this._destroyed) return;
    if (!window.Markian?.create) throw new Error('Markian factory was not provided by the configured script.');
    this.extensions = {};
    if (this.settings['MARKIAN.CODE'] !== false) {
      await loadMarkianAsset(asset('INCLUDES.MARKIAN_CODE_JS', 'extensions/code.min.js'));
      if (!window.MarkianCode?.codeExtension) throw new Error('Markian Code extension is unavailable.');
      if (!markianAssets.has('registered:code')) {
        window.Markian.registerExtension('code', window.MarkianCode.codeExtension);
        markianAssets.set('registered:code', Promise.resolve());
      }
      this.extensions.code = { enabled: true };
    }
    if (this.settings['MARKIAN.MERMAID'] !== false) {
      await Promise.all([
        loadMarkianAsset(asset('INCLUDES.MARKIAN_MERMAID_JS', 'extensions/mermaid.min.js')),
        loadMarkianAsset(asset('INCLUDES.MARKIAN_MERMAID_CSS', 'extensions/mermaid.css'), true),
      ]);
      if (!window.MarkianMermaid?.mermaidExtension) throw new Error('Markian Mermaid extension is unavailable.');
      if (!markianAssets.has('registered:mermaid')) {
        window.Markian.registerExtension('mermaid', window.MarkianMermaid.mermaidExtension);
        markianAssets.set('registered:mermaid', Promise.resolve());
      }
      const url = this.settings['INCLUDES.MERMAID_JS'];
      this.extensions.mermaid = { enabled: true, config: url ? { source: withCacheBust(resolveAssetUrl(url)) } : {} };
    }
    const previewCss = this.settings['INCLUDES.PREVIEW_CSS'];
    const previewUrls = Array.isArray(previewCss) ? previewCss : (previewCss ? [previewCss] : []);
    this.markdownCssUrls = previewUrls.length ? previewUrls.map(path => withCacheBust(resolveVendorUrl(path))) : undefined;
    const themeCss = this.settings['INCLUDES.THEME_CSS'];
    const themeUrls = Array.isArray(themeCss) ? themeCss : (themeCss ? [themeCss] : []);
    const appBase = window.CODIWARE_ASSET_BASE_APP || resolveAssetUrl(window.CODIWARE_BOOT?.url_to_app || 'vendor/kabachello/codiware/public');
    this.themeCssUrls = [withCacheBust(appBase.replace(/\/$/, '') + '/css/markian-theme.css'), ...themeUrls.map(path => withCacheBust(resolveVendorUrl(path)))];
  }

  async load(content, meta) {
    const generation = ++this._generation;
    await this._initPromise;
    if (this._destroyed || generation !== this._generation) return;
    this._currentDir = (meta?.path || '').replace(/\/?[^/]*$/, '');
    this._path = meta?.path || '';
    this._loading = true;
    try {
      if (this.editor) {
        this.editor.set(content || '', { origin: 'host-load', resetHistory: true, pending: 'discard' });
      } else {
        const mount = document.createElement('div');
        this.host.replaceChildren(mount);
        this.editor = Markian.create(mount, {
          markdown: content || '',
          initialMode: 'visual',
          sidebarVisible: this.settings['MARKIAN.SIDEBAR_VISIBLE'] ?? true,
          theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
          markdownCssUrls: this.markdownCssUrls,
          themeCssUrls: this.themeCssUrls,
          extensions: this.extensions,
          onImageResolve: ({ destination }) => this._resolveSrc(destination),
          onImageInsert: async ({ blob, signal }) => ({
            destination: await this._uploadImageBlob(blob, this._imageFileName(blob), signal),
            alt: blob.name || 'image',
          }),
          onLinkOpen: context => this._openLink(context),
          onLinkSuggest: context => this._suggest(context, false),
          onImageSuggest: context => this._suggest(context, true),
          onLinkInspect: context => this._inspect(context),
        });
        this.editorEl = this.editor.element;
        this.editorEl.classList.add('codiware-markdown-editor');
        this._previewObserver = new MutationObserver(() => this._applyMarkdownClasses());
        this._previewObserver.observe(this.editorEl, { childList: true, subtree: true });
        this.editor.on('change', () => { if (!this._loading) this._emit('change'); });
        this.editor.on('save-request', () => this._emit('save-request'));
        this.editor.on('error', event => this.ctx.toasts?.error(event.error?.message || 'Markdown editor failed.'));
        this._themeObserver = new MutationObserver(() => this._applyTheme());
        this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      }
      await this.editor.ready;
      if (this._destroyed || generation !== this._generation) return;
      this._applyMarkdownClasses();
      this.originalContent = this.editor.get();
    } finally {
      this._loading = false;
    }
    this._emit('change');
  }

  _applyMarkdownClasses() {
    const classes = String(this.settings['CSS_CLASS_FOR_PREVIEW_CONTAINER'] || '').split(/\s+/).filter(Boolean);
    if (!classes.length) return;
    for (const element of this.editorEl.querySelectorAll('.markian-document')) element.classList.add(...classes);
  }

  _isRelativeSrc(destination) {
    return !!destination && !/^(https?:|data:|blob:|#|\/)/i.test(destination);
  }

  _resolvePath(destination) {
    const url = new URL(destination, 'https://workspace.invalid/' + this._currentDir.split('/').filter(Boolean).map(encodeURIComponent).join('/') + (this._currentDir ? '/' : ''));
    if (url.origin !== 'https://workspace.invalid') throw new Error('Not a workspace destination.');
    return decodeURIComponent(url.pathname.slice(1));
  }

  _resolveSrc(destination) {
    if (!this._isRelativeSrc(destination)) return destination;
    const reference = new URL(destination, 'https://workspace.invalid/');
    const result = new URL(this.ctx.api.url('/files/download', { path: this._resolvePath(destination) }), document.baseURI);
    for (const [key, value] of reference.searchParams) if (!['path', 'root'].includes(key)) result.searchParams.append(key, value);
    result.hash = reference.hash;
    return result.href;
  }

  async _openLink({ destination, signal }) {
    if (signal.aborted) return;
    if (destination.startsWith('#')) { this.navigate(decodeURIComponent(destination.slice(1))); return; }
    if (this._isRelativeSrc(destination)) {
      const reference = new URL(destination, 'https://workspace.invalid/');
      const path = this._resolvePath(destination);
      await window.Codiware?.openFile?.({ path, name: path.split('/').pop(), root: this.ctx.api.workspace,
        fragment: decodeURIComponent(reference.hash.slice(1)), query: reference.search });
    } else if (/^https?:|^mailto:/i.test(destination)) {
      window.open(destination, '_blank', 'noopener,noreferrer');
    }
  }

  async _suggest({ query, signal }, images) {
    if (!query.trim()) return [];
    const result = await this.ctx.api.request('GET', '/files/find', { query: { q: query, limit: 30 }, signal });
    const from = this._currentDir.split('/').filter(Boolean);
    return (result?.matches || []).filter(file => images ? /\.(png|jpe?g|gif|webp)$/i.test(file.path) : /\.(md|markdown)$/i.test(file.path)).map(file => {
      const target = file.path.split('/');
      let common = 0;
      while (common < from.length && target[common] === from[common]) common++;
      return { label: file.path, destination: '../'.repeat(from.length - common) + target.slice(common).map(encodeURIComponent).join('/') };
    });
  }

  async _inspect({ destination, signal }) {
    if (!this._isRelativeSrc(destination)) return { status: 'unknown' };
    try {
      const result = await this.ctx.api.request('GET', '/files/read', { query: { path: this._resolvePath(destination) }, signal });
      if (result?.binary || String(result?.content || '').length > 1_000_000) return { status: 'unknown' };
      return { status: 'exists', headings: Markian.headings(result.content || '').map(item => ({ id: item.id, label: item.label })) };
    } catch (error) {
      if (error.status === 404) return { status: 'missing' };
      throw error;
    }
  }

  /** Save image files before their ordinary relative destinations enter Markdown. */
  async _uploadImageBlob(blob, fileName, signal) {
    const imagesDir = this._currentDir ? this._currentDir + '/images' : 'images';
    const body = new FormData();
    body.append('file', blob, fileName);
    const result = await this.ctx.api.request('POST', '/files/upload', {
      query: { path: imagesDir, autoname: 1 }, body, signal,
    });
    const saved = Array.isArray(result?.uploaded) ? result.uploaded[0] : null;
    if (!saved?.path) throw new Error('Image storage did not return a saved file.');
    const savedName = saved.path.split('/').pop();
    this.ctx?.bus?.emit?.('files:changed', { action: 'upload', path: imagesDir });
    return 'images/' + savedName;
  }

  _imageFileName(blob) {
    const subtype = ((blob.type || '').split('/')[1] || 'png').toLowerCase();
    const extensions = { jpeg: 'jpg', 'svg+xml': 'svg', 'x-icon': 'ico' };
    const extension = extensions[subtype] || subtype.replace(/[^a-z0-9]/g, '') || 'png';
    const stem = (blob.name || '')
      .replace(/\.[^./\\]+$/, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'image';
    return `${stem}.${extension}`;
  }

  _applyTheme() { this.editor?.setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'); }
  getContent() { return this.editor?.get() ?? this.originalContent; }
  isDirty() { return this.getContent() !== this.originalContent; }
  async beforeSave() { await this.editor?.whenIdle(); }
  resize() { this.editor?.resize(); }
  focus() { this.editor?.focus(); }
  markClean(snapshot) { if (snapshot) this.originalContent = snapshot.content; }

  navigate(fragment) {
    const target = Array.from(this.editor?.element.querySelectorAll('[id]') || []).find(element => element.id === fragment);
    target?.scrollIntoView({ block: 'start' });
  }

  on(event, listener) {
    this.listeners[event]?.push(listener);
    return () => {
      if (this.listeners[event]) this.listeners[event] = this.listeners[event].filter(candidate => candidate !== listener);
    };
  }

  _emit(event) { (this.listeners[event] || []).forEach(listener => listener()); }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._generation++;
    this._themeObserver?.disconnect();
    this._previewObserver?.disconnect();
    this.editor?.destroy();
    this.editor = null;
    this.editorEl = null;
    this.host.replaceChildren();
    this.listeners = { change: [], 'save-request': [] };
  }
}

export const markdownEditorDescriptor = {
  id: 'codiware.markdown',
  label: 'Markdown',
  priority: 10,
  accepts: entry => /\.(md|markdown)$/i.test(entry?.path || ''),
  create: (host, ctx) => new MarkdownEditor(host, ctx),
};