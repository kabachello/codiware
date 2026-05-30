import { EventBus } from '../core/EventBus.js';

/**
 * Read-only image viewer. Used for png/jpg/gif/webp/svg files.
 */
export class ImageEditor {
  constructor(host, ctx) {
    this.host = host;
    this.ctx = ctx;
    this._bus = new EventBus();
    host.innerHTML = '';
    host.style.display = 'flex';
    host.style.alignItems = 'center';
    host.style.justifyContent = 'center';
    host.style.padding = '12px';
    this.img = document.createElement('img');
    this.img.style.maxWidth = '100%';
    this.img.style.maxHeight = '100%';
    host.appendChild(this.img);
  }

  load(_content, meta) {
    // Use download endpoint to display the image (no need to base64-encode in JS).
    this.img.src = (this.ctx?.api?.url?.('/files/download', { path: meta?.path }) ?? '');
    this.img.alt = meta?.path || '';
  }

  getContent() { return null; }
  isDirty() { return false; }
  markClean() {}
  on(ev, fn) { return this._bus.on(ev, fn); }
  destroy() { this.host.innerHTML = ''; }
}

export const imageEditorDescriptor = {
  id: 'codiware.image',
  label: 'Image',
  priority: 20,
  accepts: (entry) => /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(entry?.path || ''),
  create: (host, ctx) => new ImageEditor(host, ctx),
};
