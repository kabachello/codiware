import { EventBus } from '../core/EventBus.js';

/**
 * Image editor backed by the TOAST UI Image Editor. Opens raster images
 * (png/jpg/gif/webp/bmp) in a full editing surface with crop, flip, rotate,
 * draw, shape, text and filter tools. SVG files are handled by other viewers.
 *
 * The library ships as two UMD bundles served from the vendor npm assets:
 * `tui-color-picker` (a dependency) and `tui-image-editor`. Both are loaded
 * with `define`/`module`/`exports` shadowed so their UMD wrappers fall back to
 * the browser-global branch and expose `window.tui.*`, even when Monaco's AMD
 * loader has installed a global `define` on the page.
 *
 * Edited images are saved back through `/files/write` using base64 encoding so
 * the binary payload survives the JSON transport untouched.
 */

const ASSET_COLOR_PICKER_JS = '/tui-color-picker/dist/tui-color-picker.js';
const ASSET_COLOR_PICKER_CSS = '/tui-color-picker/dist/tui-color-picker.css';
const ASSET_IMAGE_EDITOR_JS = '/tui-image-editor/dist/tui-image-editor.js';
const ASSET_IMAGE_EDITOR_CSS = '/tui-image-editor/dist/tui-image-editor.css';

let imageEditorCtorPromise = null;
const injectedCss = new Set();

function assetBase() {
  return (window.CODIWARE_ASSET_BASE_NPM || '/codiware/assets').replace(/\/$/, '');
}

function withCacheBust(url) {
  const v = window.CODIWARE_BOOT?.cache_bust || '';
  if (!v) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}v=${encodeURIComponent(v)}`;
}

/** Inject a stylesheet once, keyed by its resolved href. */
function injectCss(relPath) {
  const href = withCacheBust(assetBase() + relPath);
  if (injectedCss.has(href)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.codiwareImageCss = '1';
  document.head.appendChild(link);
  injectedCss.add(href);
}

/** Inject Codiware-specific tweaks once: remove the unused header and its offset. */
function injectCustomCss() {
  if (document.getElementById('codiware-image-editor-css')) return;
  const style = document.createElement('style');
  style.id = 'codiware-image-editor-css';
  style.textContent = [
    '.tui-image-editor-header { display: none !important; }',
    '.tui-image-editor-main { top: 0 !important; }',
  ].join('\n');
  document.head.appendChild(style);
}

/**
 * Fetch and evaluate a UMD bundle with `define`/`module`/`exports` shadowed so
 * it takes the browser-global branch and assigns onto `window.tui`, regardless
 * of any AMD loader present on the page.
 */
async function loadGlobalScript(relPath) {
  const src = withCacheBust(assetBase() + relPath);
  const res = await fetch(src);
  if (!res.ok) {
    throw new Error('Failed to load image editor asset: ' + src + ' (' + res.status + ')');
  }
  const code = await res.text();
  const evaluator = new Function(
    'window',
    'self',
    'globalThis',
    `var define, exports, module;\n${code}\n//# sourceURL=${src}`
  );
  evaluator.call(window, window, window, window);
}

/**
 * Load the TOAST UI Image Editor constructor once. The color picker is loaded
 * first because the image editor UMD bundle reads `window.tui.colorPicker`.
 */
function loadImageEditorCtor() {
  if (imageEditorCtorPromise) return imageEditorCtorPromise;
  imageEditorCtorPromise = (async () => {
    injectCss(ASSET_COLOR_PICKER_CSS);
    injectCss(ASSET_IMAGE_EDITOR_CSS);
    if (!window.tui?.colorPicker) {
      await loadGlobalScript(ASSET_COLOR_PICKER_JS);
    }
    if (!window.tui?.ImageEditor) {
      await loadGlobalScript(ASSET_IMAGE_EDITOR_JS);
    }
    const Ctor = window.tui?.ImageEditor;
    if (typeof Ctor !== 'function') {
      throw new Error('TOAST UI ImageEditor global not found after script load');
    }
    return Ctor;
  })().catch((e) => {
    imageEditorCtorPromise = null;
    throw e;
  });
  return imageEditorCtorPromise;
}

const DARK_THEME = {
  'common.backgroundColor': '#1e1e1e',
  'common.border': '0px',
  'menu.normalIcon.color': '#8a8a8a',
  'menu.activeIcon.color': '#ffffff',
  'menu.disabledIcon.color': '#434343',
  'menu.hoverIcon.color': '#e9e9e9',
  'submenu.backgroundColor': '#1e1e1e',
  'submenu.partition.color': '#3c3c3c',
  'submenu.normalIcon.color': '#8a8a8a',
  'submenu.activeIcon.color': '#ffffff',
  'submenu.normalLabel.color': '#8a8a8a',
  'submenu.activeLabel.color': '#ffffff',
  'range.pointer.color': '#ffffff',
  'range.bar.color': '#666666',
  'range.subbar.color': '#d1d1d1',
  'range.value.color': '#ffffff',
  'range.value.backgroundColor': '#1e1e1e',
  'range.title.color': '#ffffff',
  'colorpicker.button.border': '#1e1e1e',
  'colorpicker.title.color': '#ffffff',
};

const LIGHT_THEME = {
  'common.backgroundColor': '#ffffff',
  'common.border': '0px',
  'menu.normalIcon.color': '#8a8a8a',
  'menu.activeIcon.color': '#555555',
  'menu.disabledIcon.color': '#cccccc',
  'menu.hoverIcon.color': '#e9e9e9',
  'submenu.backgroundColor': '#f5f5f5',
  'submenu.partition.color': '#e5e5e5',
  'submenu.normalIcon.color': '#8a8a8a',
  'submenu.activeIcon.color': '#555555',
  'submenu.normalLabel.color': '#858585',
  'submenu.activeLabel.color': '#000000',
  'range.pointer.color': '#333333',
  'range.bar.color': '#cccccc',
  'range.subbar.color': '#606060',
  'range.value.color': '#000000',
  'range.value.backgroundColor': '#f5f5f5',
  'range.title.color': '#000000',
  'colorpicker.button.border': '#f5f5f5',
  'colorpicker.title.color': '#000000',
};

// Selection handles (fabric corner controls) rendered around shapes/text. The
// stroke gives them a visible border against both light and dark images.
const SELECTION_STYLE = {
  cornerStyle: 'circle',
  cornerSize: 16,
  cornerColor: '#ffffff',
  cornerStrokeColor: '#000000',
  transparentCorners: false,
  borderColor: '#4a90e2',
  rotatingPointOffset: 70,
};

export class ImageEditor {
  constructor(host, ctx) {
    this.host = host;
    this.ctx = ctx;
    this._bus = new EventBus();
    this._editor = null;
    this._dirty = false;
    this._destroyed = false;
    this._mime = 'image/png';
    this._name = 'image';
    this._url = '';
    this._themeObserver = null;
    this._zoomControlListeners = [];
    host.innerHTML = '';
    host.style.display = 'block';
    host.style.position = 'relative';
    this._el = document.createElement('div');
    this._el.style.height = '100%';
    host.appendChild(this._el);
  }

  async load(_content, meta) {
    const path = meta?.path || '';
    this._name = path.split('/').pop() || 'image';
    this._mime = this._mimeFromPath(this._name);
    this._url = this.ctx?.api?.url?.('/files/download', { path }) ?? '';
    let Ctor;
    try {
      Ctor = await loadImageEditorCtor();
    } catch (e) {
      this._el.textContent = e.message;
      return;
    }
    if (this._destroyed) return;

    injectCustomCss();
    this._Ctor = Ctor;
    this._createEditor(this._url);

    // Follow the global Codiware theme (data-theme on <html>). ToastUI applies
    // its theme at construction, so re-create the editor preserving the current
    // canvas so in-progress edits survive a theme switch.
    this._themeObserver = new MutationObserver(() => this._reloadForTheme());
    this._themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }

  _createEditor(loadUrl) {
    const theme = (document.documentElement.dataset.theme === 'dark') ? DARK_THEME : LIGHT_THEME;
    this._editor = new this._Ctor(this._el, {
      includeUI: {
        loadImage: { path: loadUrl, name: this._name },
        theme,
        menu: ['crop', 'flip', 'rotate', 'draw', 'shape', 'icon', 'text', 'mask', 'filter'],
        initMenu: 'shape',
        menuBarPosition: 'right',
      },
      selectionStyle: SELECTION_STYLE,
      applyCropSelectionStyle: true,
      applyGroupSelectionStyle: true,
      cssMaxWidth: 3000,
      cssMaxHeight: 3000,
      usageStatistics: false,
    });
    this._bindZoomControls();

    const establishCleanState = () => {
      this._editor.off('undoStackChanged', establishCleanState);
      if (this._destroyed || !this._editor) return;
      this._editor.clearUndoStack();
      this._bindDirtyTracking();
    };
    this._editor.on('undoStackChanged', establishCleanState);
  }

  _bindZoomControls() {
    this._removeZoomControlListeners();
    const bind = (selector, callback) => {
      const button = this._el.querySelector(selector);
      if (!button) return;
      const handler = (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        callback();
      };
      button.addEventListener('click', handler, true);
      this._zoomControlListeners.push({ button, handler });
    };

    bind('.tie-btn-zoomIn', () => this._zoomIn());
    bind('.tie-btn-zoomOut', () => this._editor?._graphics?.zoomOut?.());
  }

  _removeZoomControlListeners() {
    for (const { button, handler } of this._zoomControlListeners) {
      button.removeEventListener('click', handler, true);
    }
    this._zoomControlListeners = [];
  }

  _zoomIn() {
    const graphics = this._editor?._graphics;
    const canvas = graphics?.getCanvas?.();
    if (!graphics?.zoom || !canvas) return;
    const center = canvas.getCenter();
    graphics.zoom(
      { x: center.x ?? center.left, y: center.y ?? center.top },
      Math.min(canvas.getZoom() + 1, 4)
    );
  }

  _bindDirtyTracking() {
    const onChange = () => {
      if (this._dirty) return;
      this._dirty = true;
      this._bus.emit('change');
    };
    this._editor.on('undoStackChanged', onChange);
    this._editor.on('redoStackChanged', onChange);
  }

  /** Re-create the editor with the current theme, preserving canvas contents. */
  _reloadForTheme() {
    if (!this._editor || this._destroyed) return;
    let dataUrl = this._url;
    try { dataUrl = this._editor.toDataURL({ format: this._formatFromMime(this._mime) }); } catch (e) { /* ignore */ }
    this._removeZoomControlListeners();
    try { this._editor.destroy?.(); } catch (e) { /* ignore */ }
    this._editor = null;
    this._createEditor(dataUrl);
  }

  /**
   * Provide a base64 payload so the tab manager can persist edited binary image
   * data through `/files/write` without corrupting it in JSON transport.
   */
  getSavePayload() {
    if (!this._editor) return null;
    const dataUrl = this._editor.toDataURL({ format: this._formatFromMime(this._mime) });
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return { content: base64, encoding: 'base64' };
  }

  getContent() { return null; }
  isDirty() { return this._dirty; }
  markClean() { this._dirty = false; }
  on(ev, fn) { return this._bus.on(ev, fn); }

  destroy() {
    this._destroyed = true;
    if (this._themeObserver) {
      this._themeObserver.disconnect();
      this._themeObserver = null;
    }
    this._removeZoomControlListeners();
    try { this._editor?.destroy?.(); } catch (e) { /* ignore */ }
    this._editor = null;
    this.host.innerHTML = '';
  }

  _mimeFromPath(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
    }[ext] || 'image/png';
  }

  _formatFromMime(mime) {
    return mime === 'image/jpeg' ? 'jpeg' : (mime === 'image/webp' ? 'webp' : 'png');
  }
}

export const imageEditorDescriptor = {
  id: 'codiware.image',
  label: 'Image',
  priority: 20,
  accepts: (entry) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(entry?.path || ''),
  create: (host, ctx) => new ImageEditor(host, ctx),
};
