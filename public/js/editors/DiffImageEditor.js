import { EventBus } from '../core/EventBus.js';

/**
 * Side-by-side image diff viewer for Git changes.
 *
 * Text diffs use Monaco because line highlighting and block reverting make
 * sense there. Binary raster images cannot be represented safely as UTF-8 text,
 * so the Git API returns each available side as a data URL and this editor lays
 * the old and new versions next to each other. Missing sides are rendered as an
 * explicit empty placeholder, which covers newly added and deleted images.
 */
export class DiffImageEditor {
  constructor(host, ctx) {
    this.host = host;
    this.ctx = ctx;
    this._bus = new EventBus();
    this._data = null;

    host.innerHTML = '';
    host.classList.add('diff-image-editor-host');
    this._root = document.createElement('div');
    this._root.className = 'diff-image-editor';
    host.appendChild(this._root);
  }

  /**
   * Render the image diff payload returned by `/git/diff` or `/git/commit-diff`.
   *
   * The expected payload has `old_image` and `new_image` objects. Each side may
   * be absent or have `exists: false`; such sides are displayed as an empty
   * placeholder instead of attempting to load a broken image URL.
   */
  load(data) {
    this._data = data || {};
    this._root.replaceChildren();

    const header = document.createElement('div');
    header.className = 'diff-image-header';
    header.textContent = this._data.path || '';
    this._root.append(header);

    const panes = document.createElement('div');
    panes.className = 'diff-image-panes';
    panes.append(
      this._renderSide('old', this._data.old_image, this._label('diff.image_old', 'Old image')),
      this._renderSide('new', this._data.new_image, this._label('diff.image_new', 'New image'))
    );
    this._root.append(panes);
  }

  /** Build one labelled image pane or an empty-state pane for missing sides. */
  _renderSide(kind, image, title) {
    const pane = document.createElement('section');
    pane.className = `diff-image-side diff-image-side-${kind}`;

    const bar = document.createElement('div');
    bar.className = 'diff-image-side-title';
    const titleEl = document.createElement('span');
    titleEl.textContent = title;
    bar.append(titleEl);
    if (image?.exists && image?.size) {
      const meta = document.createElement('span');
      meta.className = 'diff-image-meta';
      meta.textContent = this._formatBytes(image.size);
      bar.append(meta);
    }
    pane.append(bar);

    const body = document.createElement('div');
    body.className = 'diff-image-side-body';
    if (image?.exists && image?.src) {
      const img = document.createElement('img');
      img.className = 'diff-image-preview';
      img.src = image.src;
      img.alt = title;
      img.draggable = false;
      body.append(img);
    } else {
      const empty = document.createElement('div');
      empty.className = 'diff-image-empty';
      empty.textContent = this._label('diff.image_empty', '(empty)');
      body.append(empty);
    }
    pane.append(body);
    return pane;
  }

  /** Translate a label key while keeping a plain fallback for early bootstrap. */
  _label(key, fallback) {
    const translated = this.ctx?.i18n?.t?.(key);
    return translated && translated !== key ? translated : fallback;
  }

  /** Format byte counts for compact side metadata. */
  _formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  getContent() { return null; }
  isDirty() { return false; }
  markClean() {}
  focus() { this._root?.focus?.(); }
  on(ev, fn) { return this._bus.on(ev, fn); }

  destroy() {
    this.host.classList.remove('diff-image-editor-host');
    this.host.innerHTML = '';
    this._data = null;
  }
}

export const diffImageEditorDescriptor = {
  id: 'codiware.diffImage',
  label: 'Image diff',
  priority: 100,
  accepts: () => false,
  create: (host, ctx) => new DiffImageEditor(host, ctx),
};
