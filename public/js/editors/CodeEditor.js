import { EventBus } from '../core/EventBus.js';

/**
 * Plain `<textarea>` based code editor. Acts as the fallback when no richer
 * editor (Monaco, CodeMirror, …) is registered for the file type.
 */
export class CodeEditor {
  constructor(host, ctx) {
    this.host = host;
    this.ctx = ctx;
    this._bus = new EventBus();
    this._content = '';
    this._dirty = false;

    this.ta = document.createElement('textarea');
    this.ta.className = 'code-area';
    this.ta.spellcheck = false;
    this.ta.wrap = 'off';
    this.ta.addEventListener('input', () => {
      this._content = this.ta.value;
      this._dirty = true;
      this._bus.emit('change', this);
    });
    this.ta.addEventListener('keydown', (e) => {
      // Ctrl/Cmd+S → save
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this._bus.emit('save-request', this);
      }
      // Tab inserts spaces.
      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const ts = (ctx && ctx.editor && ctx.editor.tab_size) || 4;
        const indent = ' '.repeat(ts);
        const start = this.ta.selectionStart;
        const end = this.ta.selectionEnd;
        this.ta.value = this.ta.value.slice(0, start) + indent + this.ta.value.slice(end);
        this.ta.selectionStart = this.ta.selectionEnd = start + indent.length;
        this.ta.dispatchEvent(new Event('input'));
      }
    });

    host.innerHTML = '';
    host.appendChild(this.ta);
  }

  load(content) {
    this._content = String(content ?? '');
    this.ta.value = this._content;
    this._dirty = false;
  }

  getContent() { return this._content; }
  isDirty() { return this._dirty; }
  markClean() { this._dirty = false; this._bus.emit('clean', this); }

  on(ev, fn) { return this._bus.on(ev, fn); }
  destroy() { this.host.innerHTML = ''; }
}

export const codeEditorDescriptor = {
  id: 'codiware.code',
  label: 'Code',
  priority: 0,
  accepts: () => true, // last-resort fallback
  create: (host, ctx) => new CodeEditor(host, ctx),
};
