import { CodeEditor } from './CodeEditor.js';

/**
 * Markdown editor: split textarea + preview. Initial implementation reuses
 * `CodeEditor` for the source side; a richer editor (Toast UI / MDE) can
 * replace it later via the registry.
 */
export class MarkdownEditor {
  constructor(host, ctx) {
    this.host = host;
    this.ctx = ctx;
    host.innerHTML = '';
    host.style.display = 'grid';
    host.style.gridTemplateColumns = '1fr 1fr';
    host.style.gap = '1px';
    host.style.background = 'var(--ide-border)';

    const left = document.createElement('div');
    left.style.background = 'var(--ide-bg)';
    left.style.minHeight = '0';
    left.style.overflow = 'auto';

    this.preview = document.createElement('div');
    this.preview.style.background = 'var(--ide-bg)';
    this.preview.style.padding = '12px';
    this.preview.style.overflow = 'auto';

    host.append(left, this.preview);
    this.code = new CodeEditor(left, ctx);
    this.code.on('change', () => this._render());
  }

  load(content, meta) { this.code.load(content, meta); this._render(); }
  getContent() { return this.code.getContent(); }
  isDirty() { return this.code.isDirty(); }
  markClean() { this.code.markClean(); }
  on(ev, fn) { return this.code.on(ev, fn); }
  destroy() { this.host.innerHTML = ''; }

  _render() {
    // Minimal markdown rendering: just escape and turn newlines into <br>.
    const raw = this.code.getContent();
    const esc = raw.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    this.preview.innerHTML = '<pre style="white-space:pre-wrap">' + esc + '</pre>';
  }
}

export const markdownEditorDescriptor = {
  id: 'codiware.markdown',
  label: 'Markdown',
  priority: 10,
  accepts: (entry) => /\.(md|markdown)$/i.test(entry?.path || ''),
  create: (host, ctx) => new MarkdownEditor(host, ctx),
};
