import { EventBus } from '../core/EventBus.js';

const CROPPER_JS = '/cropperjs/dist/cropper.esm.min.js';
let cropperPromise;

function assetUrl(path) {
  const base = (window.CODIWARE_ASSET_BASE_NPM || '/codiware/assets').replace(/\/$/, '');
  const version = window.CODIWARE_BOOT?.cache_bust || '';
  return base + path + (version ? `?v=${encodeURIComponent(version)}` : '');
}

function loadCropper() {
  if (!cropperPromise) {
    cropperPromise = import(assetUrl(CROPPER_JS)).catch(error => {
      cropperPromise = null;
      throw error;
    });
  }
  return cropperPromise;
}

/** Applied pixels remain independent of Cropper's viewport and pending selection. */
export class ImageEditor {
  constructor(host, ctx) {
    this.host = host;
    this.ctx = ctx;
    this._bus = new EventBus();
    this._destroyed = false;
    this._busy = false;
    this._cropping = false;
    this._scaling = false;
    this._ready = false;
    this._pending = Promise.resolve();
    this._undo = [];
    this._redo = [];
    this._buttons = new Map();
    host.replaceChildren();
    this._el = document.createElement('div');
    this._el.className = 'codiware-image-editor';
    this._el.tabIndex = -1;
    this._toolbar = document.createElement('div');
    this._toolbar.className = 'ide-editor-toolbar';
    this._toolbar.setAttribute('role', 'toolbar');
    this._toolbar.setAttribute('aria-label', 'Image');
    this._stage = document.createElement('div');
    this._stage.className = 'codiware-image-stage';
    this._status = document.createElement('div');
    this._status.className = 'codiware-image-status';
    this._status.setAttribute('role', 'status');
    this._el.append(this._toolbar, this._stage, this._status);
    host.append(this._el);
    this._buildToolbar();
    this._el.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        event.stopPropagation();
        this._bus.emit('save-request');
      }
      if (event.key === 'Escape' && this._scaling && !this._busy) this._cancelScale();
      else if (event.key === 'Escape' && this._cropping && !this._busy) this._cancelCrop();
      else if (event.key === 'Escape' && !this._busy && this._hasSizeChanges()) this._syncDimensions();
    });
    this._observer = new ResizeObserver(() => this.resize());
    this._observer.observe(this._stage);
  }

  _label(key, fallback) {
    const translated = this.ctx?.i18n?.t?.(`image.${key}`);
    return translated && translated !== `image.${key}` ? translated : fallback;
  }

  _button(key, icon, label, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ide-editor-tool';
    button.title = this._label(key, label);
    button.setAttribute('aria-label', button.title);
    button.dataset.imageAction = key;
    const glyph = document.createElement('i');
    glyph.className = `fa fa-${icon}`;
    glyph.setAttribute('aria-hidden', 'true');
    button.append(glyph);
    button.addEventListener('click', () => {
      if (!this._busy) action();
    });
    this._toolbar.append(button);
    this._buttons.set(key, button);
    return button;
  }

  _divider() {
    const divider = document.createElement('span');
    divider.className = 'ide-editor-tool-divider';
    divider.setAttribute('role', 'separator');
    this._toolbar.append(divider);
  }

  _buildToolbar() {
    this._button('undo', 'undo', 'Undo', () => this._restore(this._undo, this._redo));
    this._button('redo', 'repeat', 'Redo', () => this._restore(this._redo, this._undo));
    this._divider();
    this._button('crop', 'crop', 'Crop', () => this._cropping ? this._cancelCrop() : this._startCrop());
    this._button('applyCrop', 'check', 'Apply crop', () => this._run(() => this._applyCrop()));
    this._button('cancelCrop', 'times', 'Cancel crop', () => this._cancelCrop());
    this._button('scale', 'arrows-alt', 'Scale image', () => this._scaling ? this._cancelScale() : this._startScale());
    this._button('applyScale', 'check', 'Apply scale', () => this._run(() => this._applyScale()));
    this._button('cancelScale', 'times', 'Discard scale', () => this._cancelScale());
    for (const [tool, apply, discard] of [['crop', 'applyCrop', 'cancelCrop'], ['scale', 'applyScale', 'cancelScale']]) {
      const group = document.createElement('span');
      group.className = 'ide-editor-tool-group';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', this._buttons.get(tool).title);
      this._buttons.get(tool).before(group);
      group.append(this._buttons.get(tool), this._buttons.get(apply), this._buttons.get(discard));
    }
    this._divider();
    this._width = this._dimensionInput('width', 'Width');
    this._lock = this._button('lock', 'link', 'Lock aspect ratio', () => {
      this._locked = !this._locked;
      this._syncControls();
    });
    this._locked = true;
    this._height = this._dimensionInput('height', 'Height');
    this._button('resize', 'check', 'Apply size', () => this._run(() => this._applySize()));
    this._button('cancelResize', 'times', 'Discard size changes', () => this._syncDimensions());
    const sizeGroup = document.createElement('span');
    sizeGroup.className = 'ide-editor-tool-group';
    sizeGroup.setAttribute('role', 'group');
    sizeGroup.setAttribute('aria-label', `${this._width.title} / ${this._height.title}`);
    this._width.before(sizeGroup);
    sizeGroup.append(this._width, this._lock, this._height, this._buttons.get('resize'), this._buttons.get('cancelResize'));
    this._divider();
    this._button('zoomOut', 'search-minus', 'Zoom out', () => this._image.$zoom(-0.2));
    this._button('zoomIn', 'search-plus', 'Zoom in', () => this._image.$zoom(0.2));
    this._button('fit', 'expand', 'Fit image', () => this.resize());
    this._divider();
    this._button('reset', 'refresh', 'Reset image', () => this._run(async () => {
      await this._commit(await this._canvasFromUrl(this._original));
    }));
    this._syncControls();
  }

  _dimensionInput(key, label) {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '16384';
    input.step = '1';
    input.required = true;
    input.title = this._label(key, label);
    input.setAttribute('aria-label', input.title);
    input.dataset.imageDimension = key;
    input.addEventListener('input', () => {
      if (this._canvas && this._locked && input.validity.valid) {
        const ratio = this._canvas.width / this._canvas.height;
        const other = key === 'width' ? this._height : this._width;
        other.value = Math.max(1, Math.round(key === 'width' ? input.valueAsNumber / ratio : input.valueAsNumber * ratio));
      }
      this._syncControls();
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !this._busy) {
        event.preventDefault();
        this._buttons.get('resize').click();
      }
    });
    this._toolbar.append(input);
    return input;
  }

  async load(_content, meta) {
    this._mime = /\.jpe?g$/i.test(meta?.path || '') ? 'image/jpeg' : /\.webp$/i.test(meta?.path || '') ? 'image/webp' : 'image/png';
    this._busy = true;
    this._syncControls();
    try {
      const [{ default: Cropper }, canvas] = await Promise.all([
        loadCropper(),
        this._canvasFromUrl(this.ctx.api.url('/files/download', { path: meta.path })),
      ]);
      if (this._destroyed) return;
      this._canvas = canvas;
      this._original = canvas.toDataURL();
      const image = document.createElement('img');
      image.src = this._original;
      this._cropper = new Cropper(image, {
        container: this._stage,
        template: '<cropper-canvas background><cropper-image initial-fit="scale-down" scalable translatable></cropper-image><cropper-shade hidden></cropper-shade><cropper-handle action="move" plain></cropper-handle><cropper-selection hidden movable resizable><cropper-grid role="grid" bordered covered theme-color="rgba(255, 255, 255, 0.8)"></cropper-grid><cropper-crosshair centered></cropper-crosshair><cropper-handle action="move" theme-color="rgba(255, 255, 255, 0.12)"></cropper-handle><cropper-handle action="n-resize"></cropper-handle><cropper-handle action="e-resize"></cropper-handle><cropper-handle action="s-resize"></cropper-handle><cropper-handle action="w-resize"></cropper-handle><cropper-handle action="ne-resize"></cropper-handle><cropper-handle action="nw-resize"></cropper-handle><cropper-handle action="se-resize"></cropper-handle><cropper-handle action="sw-resize"></cropper-handle></cropper-selection></cropper-canvas>',
      });
      this._image = this._cropper.getCropperImage();
      this._selection = this._cropper.getCropperSelection();
      this._shade = this._stage.querySelector('cropper-shade');
      this._selection.addEventListener('change', event => this._previewScale(event));
      for (const handle of this._selection.querySelectorAll('cropper-handle[action$="-resize"]')) {
        handle.$addStyles(':host([action$="-resize"])::after { width: 8px; height: 8px; border: 1px solid #fff; background: #222; box-sizing: border-box; }');
      }
      await this._image.$ready();
      if (this._destroyed) return;
      this._ready = true;
      this.resize();
      this._baseline = this.getSavePayload().content;
      this._syncDimensions();
    } catch (error) {
      if (!this._destroyed) this._status.textContent = error.message;
    } finally {
      this._busy = false;
      if (!this._destroyed) this._syncControls();
    }
  }

  async _canvasFromUrl(url) {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return canvas;
  }

  _startScale() {
    if (!this._ready || this._busy || this._cropping || this._hasSizeChanges()) return;
    const bounds = this._image.getBoundingClientRect();
    const stage = this._cropper.getCropperCanvas().getBoundingClientRect();
    this._scaleTransform = this._image.$getTransform();
    this._scalePixelsPerUnit = this._canvas.width / bounds.width;
    this._scaling = true;
    this._stage.dataset.imageMode = 'scale';
    this._shade.hidden = true;
    this._selection.movable = false;
    this._selection.precise = true;
    this._selection.aspectRatio = this._canvas.width / this._canvas.height;
    this._selection.hidden = false;
    this._image.translatable = false;
    this._image.scalable = false;
    this._selection.$change(bounds.left - stage.left, bounds.top - stage.top, bounds.width, bounds.height);
    this._syncControls();
  }

  _previewScale(event) {
    if (!this._scaling || this._busy || this._destroyed) return;
    const { x, y, width, height } = event.detail;
    const pixelWidth = Math.round(width * this._scalePixelsPerUnit);
    const pixelHeight = Math.round(pixelWidth * this._canvas.height / this._canvas.width);
    if (![pixelWidth, pixelHeight].every(value => Number.isInteger(value) && value >= 1 && value <= 16384) || pixelWidth * pixelHeight > 40000000) {
      event.preventDefault();
      return;
    }
    const scale = width / this._canvas.width;
    this._image.scalable = true;
    this._image.$setTransform(scale, 0, 0, scale, x + (width - this._canvas.width) / 2, y + (height - this._canvas.height) / 2);
    this._image.scalable = false;
    this._width.value = pixelWidth;
    this._height.value = pixelHeight;
    this._status.textContent = `${pixelWidth} x ${pixelHeight} px`;
    this._syncControls();
  }

  _cancelScale() {
    this._scaling = false;
    delete this._stage.dataset.imageMode;
    this._selection.hidden = true;
    this._selection.movable = true;
    this._selection.precise = false;
    this._selection.aspectRatio = NaN;
    this._shade.hidden = true;
    this._image.translatable = true;
    this._image.scalable = true;
    this._image.$setTransform(...this._scaleTransform);
    this._syncDimensions();
  }

  async _applyScale() {
    await this._applySize();
    if (this._scaling) this._cancelScale();
  }

  _startCrop() {
    if (!this._ready || this._busy) return;
    const bounds = this._image.getBoundingClientRect();
    const stage = this._cropper.getCropperCanvas().getBoundingClientRect();
    this._cropping = true;
    this._selection.hidden = false;
    this._shade.hidden = false;
    this._selection.$change(bounds.left - stage.left + bounds.width * 0.1, bounds.top - stage.top + bounds.height * 0.1, bounds.width * 0.8, bounds.height * 0.8);
    this._image.translatable = false;
    this._image.scalable = false;
    this._syncControls();
  }

  _cancelCrop() {
    this._cropping = false;
    if (this._selection) this._selection.hidden = true;
    if (this._shade) this._shade.hidden = true;
    if (this._image) {
      this._image.translatable = true;
      this._image.scalable = true;
    }
    this._syncControls();
  }

  async _applyCrop() {
    if (!this._cropping) return;
    const bounds = this._image.getBoundingClientRect();
    const stage = this._cropper.getCropperCanvas().getBoundingClientRect();
    const scaleX = this._canvas.width / bounds.width;
    const scaleY = this._canvas.height / bounds.height;
    const left = this._selection.x - bounds.left + stage.left;
    const top = this._selection.y - bounds.top + stage.top;
    const sourceX = Math.max(0, Math.round(left * scaleX));
    const sourceY = Math.max(0, Math.round(top * scaleY));
    const right = Math.min(this._canvas.width, Math.round((left + this._selection.width) * scaleX));
    const bottom = Math.min(this._canvas.height, Math.round((top + this._selection.height) * scaleY));
    const width = right - sourceX;
    const height = bottom - sourceY;
    if (width < 1 || height < 1) throw new Error(this._label('emptyCrop', 'Select an area inside the image.'));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(this._canvas, sourceX, sourceY, width, height, 0, 0, width, height);
    await this._commit(canvas);
  }

  async _applySize() {
    const width = this._width.valueAsNumber;
    const height = this._height.valueAsNumber;
    if (![width, height].every(value => Number.isInteger(value) && value >= 1 && value <= 16384) || width * height > 40000000) {
      throw new Error(this._label('sizeLimit', 'Image size must not exceed 16384 pixels per side or 40 megapixels.'));
    }
    if (width === this._canvas.width && height === this._canvas.height) return;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(this._canvas, 0, 0, width, height);
    await this._commit(canvas);
  }

  _run(operation) {
    if (this._busy || this._destroyed || !this._ready) return this._pending;
    this._busy = true;
    this._syncControls();
    this._pending = (async () => {
      try {
        await operation();
      } finally {
        this._busy = false;
        if (!this._destroyed) this._syncControls();
      }
    })();
    this._pending.catch(error => {
      if (!this._destroyed) this._status.textContent = error.message;
    });
    return this._pending;
  }

  async _commit(canvas, remember = true) {
    if (this._destroyed) return;
    const source = canvas.toDataURL();
    const previous = this._canvas.toDataURL();
    if (source === previous) {
      if (this._scaling) this._cancelScale();
      this._cancelCrop();
      return;
    }
    if (remember) {
      this._undo.push(previous);
      if (this._undo.length > 10) this._undo.shift();
      this._redo = [];
    }
    const nativeImage = await this._image.$ready();
    if (this._destroyed) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        nativeImage.removeEventListener('load', loaded);
        nativeImage.removeEventListener('error', failed);
      };
      const loaded = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('Failed to load edited image.')); };
      nativeImage.addEventListener('load', loaded);
      nativeImage.addEventListener('error', failed);
      this._image.setAttribute('src', source);
    });
    if (this._destroyed) return;
    this._canvas = canvas;
    if (this._scaling) this._cancelScale();
    this._cancelCrop();
    this.resize();
    this._syncDimensions();
    this._bus.emit('change');
  }

  _restore(from, to) {
    if (!from.length) return;
    return this._run(async () => {
      const canvas = await this._canvasFromUrl(from[from.length - 1]);
      to.push(this._canvas.toDataURL());
      from.pop();
      await this._commit(canvas, false);
    });
  }

  _syncDimensions() {
    this._width.value = this._canvas.width;
    this._height.value = this._canvas.height;
    this._status.textContent = `${this._canvas.width} x ${this._canvas.height} px`;
    this._syncControls();
  }

  _hasSizeChanges() {
    return !!(this._canvas && this._width && this._height
      && (this._width.valueAsNumber !== this._canvas.width || this._height.valueAsNumber !== this._canvas.height));
  }

  _syncControls() {
    const resizing = this._hasSizeChanges();
    for (const [key, button] of this._buttons) {
      button.disabled = this._busy || !this._ready;
      if (key === 'undo') button.disabled ||= !this._undo.length;
      if (key === 'redo') button.disabled ||= !this._redo.length;
      if (key === 'applyCrop' || key === 'cancelCrop') button.hidden = !this._cropping;
      if (key === 'applyScale' || key === 'cancelScale') button.hidden = !this._scaling;
      if (key === 'resize' || key === 'cancelResize') button.hidden = !resizing || this._cropping || this._scaling;
      if (key === 'resize' && resizing) button.disabled ||= !this._width.validity.valid || !this._height.validity.valid || this._width.valueAsNumber * this._height.valueAsNumber > 40000000;
      if (resizing && ['crop', 'undo', 'redo', 'reset'].includes(key)) button.disabled = true;
      if (resizing && key === 'scale' && !this._scaling) button.disabled = true;
      if (this._cropping && !['crop', 'applyCrop', 'cancelCrop'].includes(key)) button.disabled = true;
      if (this._scaling && !['scale', 'applyScale', 'cancelScale'].includes(key)) button.disabled = true;
    }
    this._buttons.get('crop')?.setAttribute('aria-pressed', String(this._cropping));
    this._buttons.get('scale')?.setAttribute('aria-pressed', String(this._scaling));
    this._lock?.setAttribute('aria-pressed', String(this._locked));
    for (const input of [this._width, this._height]) {
      if (input) input.disabled = this._busy || !this._ready || this._cropping || this._scaling;
    }
  }

  resize() {
    if (!this._ready || this._destroyed || !this._stage.clientWidth || !this._stage.clientHeight || this._cropping || this._scaling) return;
    this._image.$resetTransform();
    this._image.$center('scale-down');
  }

  async beforeSave() {
    await this._pending;
    if (this._scaling) await this._run(() => this._applyScale());
    if (this._cropping) await this._run(() => this._applyCrop());
    if (!this._ready) throw new Error(this._label('notReady', 'Image is not ready to save.'));
  }

  getSavePayload() {
    if (!this._canvas) return null;
    const dataUrl = this._canvas.toDataURL(this._mime, 0.92);
    return { content: dataUrl.slice(dataUrl.indexOf(',') + 1), encoding: 'base64' };
  }

  getContent() { return null; }
  isDirty() { return this._ready ? this.getSavePayload().content !== this._baseline : false; }
  markClean(snapshot) {
    if (snapshot) this._baseline = snapshot.content;
  }
  on(event, listener) { return this._bus.on(event, listener); }
  focus() { this._el.focus({ preventScroll: true }); }

  destroy() {
    this._destroyed = true;
    this._ready = false;
    this._observer.disconnect();
    this.host.replaceChildren();
    this._canvas = null;
    this._image = null;
    this._selection = null;
    this._shade = null;
    this._cropper = null;
    this._undo = [];
    this._redo = [];
  }
}

export const imageEditorDescriptor = {
  id: 'codiware.image',
  label: 'Image',
  priority: 20,
  accepts: entry => /\.(png|jpe?g|gif|webp|bmp)$/i.test(entry?.path || ''),
  create: (host, ctx) => new ImageEditor(host, ctx),
};
