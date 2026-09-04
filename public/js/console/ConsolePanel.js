/**
 * Bottom console panel built on xterm.js.
 *
 * The panel is a generic command-output hub with two ingestion paths:
 *   - `run(command)`   — submit a command and stream its live output.
 *   - `inject(block)`  — echo an already-executed CLI block (e.g. produced by
 *                        the Git panel) without running anything.
 *
 * Both paths are also reachable through the event bus topics `console:run`
 * and `console:inject`, so features can route output here without importing
 * this module. It knows nothing about Git or any specific command family.
 *
 * Output is written verbatim into the terminal, so ANSI colors emitted by the
 * back-end render as real terminal colors. No exit code is printed; success vs
 * failure is reflected through the header status badge and the prompt marker.
 */
import { Icon } from '../core/Icon.js';
import { PopupMenu } from '../core/PopupMenu.js';
import { ConsoleClient } from './ConsoleClient.js';

const XTERM_JS = '/xterm--xterm/lib/xterm.js';
const XTERM_CSS = '/xterm--xterm/css/xterm.css';

let xtermPromise = null;

/**
 * Load the xterm UMD bundle + stylesheet once from the vendor npm assets.
 * The UMD build assigns `Terminal` onto the global scope.
 */
function loadXterm() {
  if (window.Terminal) return Promise.resolve(window.Terminal);
  if (xtermPromise) return xtermPromise;
  const npmBase = window.CODIWARE_ASSET_BASE_NPM || '';
  const v = window.CODIWARE_BOOT?.cache_bust || '';
  const suffix = v ? '?v=' + v : '';
  if (!document.getElementById('codiware-css-xterm')) {
    const link = document.createElement('link');
    link.id = 'codiware-css-xterm';
    link.rel = 'stylesheet';
    link.href = npmBase + XTERM_CSS + suffix;
    document.head.appendChild(link);
  }
  xtermPromise = new Promise((resolve, reject) => {
    const src = npmBase + XTERM_JS + suffix;

    // Plain <script> fallback used only when the bundle cannot be fetched
    // (e.g. a strict CSP blocks `new Function`/fetch). This only yields a usable
    // `window.Terminal` when no AMD `define.amd` is on the page.
    const viaScript = () => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => (window.Terminal
        ? resolve(window.Terminal)
        : reject(new Error('xterm loaded but window.Terminal is undefined')));
      s.onerror = () => reject(new Error('Failed to load xterm from ' + s.src));
      document.head.appendChild(s);
    };

    // xterm ships as a UMD bundle. When Monaco's AMD loader is present (its
    // `define.amd` stays on `window` so Monaco can keep lazy-loading), the UMD
    // wrapper registers xterm as an anonymous AMD module and never exposes
    // `window.Terminal`. Rather than fight the global `define`, fetch the bundle
    // and run it with a real CommonJS `module`/`exports` and `define` left
    // undefined — this forces xterm's `module.exports = factory()` branch, from
    // which we read `Terminal` directly. Deterministic regardless of Monaco.
    fetch(src)
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then((code) => {
        const mod = { exports: {} };
        const factory = new Function('define', 'module', 'exports', code + '\n//# sourceURL=' + XTERM_JS);
        factory.call(window, undefined, mod, mod.exports);
        const Terminal = (mod.exports && mod.exports.Terminal) || window.Terminal;
        if (!Terminal) throw new Error('xterm bundle did not export Terminal');
        window.Terminal = Terminal;
        resolve(Terminal);
      })
      .catch(() => viaScript()); // fetch/CSP failure: fall back to a plain tag
  });
  return xtermPromise;
}

const THEMES = {
  dark: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4' },
  light: { background: '#ffffff', foreground: '#1f2328', cursor: '#1f2328' },
};

export class ConsolePanel {
  constructor({ api, i18n, toasts, bus, open }) {
    this.api = api;
    this.i18n = i18n;
    this.toasts = toasts;
    this.bus = bus;
    this.open = typeof open === 'function' ? open : () => {};
    this.client = new ConsoleClient(api);

    this.presets = [];
    this.history = this._loadHistory();
    this.historyIndex = this.history.length;
    this.line = '';
    this.cursor = 0;
    this.running = false;
    this.abort = null;
    this.lastFailed = false;
    this.promptActive = false;

    this.term = null;
    this.ready = false;
    this.queue = [];
    this.commandBlockIndex = 0;

    // Subscribe immediately (before first mount) so UI-triggered output is
    // never missed. Actions received before the terminal is ready are queued
    // and flushed once it is.
    bus?.on?.('console:run', (p) => this.run(p?.command, p || {}));
    bus?.on?.('console:inject', (p) => this.inject(p, p || {}));
  }

  async mount(host) {
    this.host = host;
    host.innerHTML = '';
    host.classList.add('console-panel');

    // Header: status badge + stop button + presets.
    const header = document.createElement('div');
    header.className = 'console-header';

    this.statusEl = document.createElement('span');
    this.statusEl.className = 'console-status is-idle';
    this.statusEl.textContent = this._t('console.idle', 'Idle');

    this.stopBtn = document.createElement('button');
    this.stopBtn.type = 'button';
    this.stopBtn.className = 'console-stop';
    this.stopBtn.title = this._t('console.stop', 'Stop');
    this.stopBtn.setAttribute('aria-label', this._t('console.stop', 'Stop'));
    this.stopBtn.append(Icon.render('fa fa-stop'));
    this.stopBtn.disabled = true;
    this.stopBtn.addEventListener('click', () => this.stop());

    this.presetsRow = document.createElement('div');
    this.presetsRow.className = 'console-presets';

    header.append(this.statusEl, this.stopBtn, this.presetsRow);

    this.termEl = document.createElement('div');
    this.termEl.className = 'console-term';

    host.append(header, this.termEl);

    // Presets are independent of xterm; load them right away.
    this.client.presets()
      .then((p) => { this.presets = p; this._renderPresets(); })
      .catch((e) => this.toasts?.error?.(e.message));

    try {
      const Terminal = await loadXterm();
      this._initTerminal(Terminal);
    } catch (e) {
      this.termEl.textContent = e.message;
      this.toasts?.error?.(e.message);
    }
  }

  _initTerminal(Terminal) {
    const theme = THEMES[document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'];
    this.term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'var(--ide-font-mono), monospace',
      fontSize: 13,
      scrollback: 5000,
      rightClickSelectsWord: true,
      theme,
    });
    this.term.open(this.termEl);
    this._fit();

    // xterm draws its output on a canvas, so the browser's regular text
    // context menu cannot reliably copy it. Provide explicit terminal actions
    // and also populate keyboard copy events from xterm's logical selection.
    this.termEl.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      PopupMenu.openAt(event.clientX, event.clientY, [
        {
          icon: 'fa fa-copy',
          label: this._t('console.copy', 'Copy'),
          disabled: !this.term?.hasSelection?.(),
          onClick: () => this._copySelection(),
        },
        {
          icon: 'fa fa-i-cursor',
          label: this._t('console.select_all', 'Select all'),
          onClick: () => this.term?.selectAll?.(),
        },
      ]);
    });
    this.termEl.addEventListener('copy', (event) => {
      const selection = this.term?.getSelection?.() || '';
      if (!selection || !event.clipboardData) return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', selection);
    });

    this._resizeObserver = new ResizeObserver(() => {
      if (this._fitRaf) cancelAnimationFrame(this._fitRaf);
      this._fitRaf = requestAnimationFrame(() => this._fit());
    });
    this._resizeObserver.observe(this.termEl);

    // React to theme switches.
    this._themeObserver = new MutationObserver(() => {
      if (!this.term) return;
      const next = THEMES[document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'];
      this.term.options.theme = next;
    });
    this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // Let the browser handle clipboard shortcuts natively so the console
    // behaves like a regular terminal: Ctrl/Cmd+V pastes (the resulting
    // `paste` event is fed back through onData) and Ctrl/Cmd+C copies the
    // current selection. Returning false tells xterm not to consume the key.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return true;
      const key = e.key.toLowerCase();
      if (key === 'v') return false;                         // paste
      if (key === 'c' && (this.term.hasSelection() || e.shiftKey)) return false; // copy
      if (key === 'x' && this.term.hasSelection()) return false; // cut (copy)
      if (key === 'a' && e.shiftKey) return false;           // select all
      return true;
    });

    this.term.onData((data) => this._onData(data));

    this.ready = true;
    this.term.write(this._t('console.welcome', 'Codiware console. Type an allowed command and press Enter.'));
    this.term.write('\r\n');
    this._writePrompt();
    this._drainQueue();
  }

  /** Minimal resize-to-fit (FitAddon is not bundled with xterm). */
  _fit() {
    if (!this.term || !this.termEl) return;
    const rect = this.termEl.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) return;
    let cellW = 8;
    let cellH = 17;
    const dims = this.term._core?._renderService?.dimensions;
    const cell = dims?.css?.cell;
    if (cell?.width && cell?.height) {
      cellW = cell.width;
      cellH = cell.height;
    } else if (dims?.actualCellWidth && dims?.actualCellHeight) {
      cellW = dims.actualCellWidth;
      cellH = dims.actualCellHeight;
    }
    const cols = Math.max(20, Math.floor((rect.width - 8) / cellW));
    const rows = Math.max(4, Math.floor((rect.height - 4) / cellH));
    try { this.term.resize(cols, rows); } catch { /* ignore transient resize errors */ }
  }

  _renderPresets() {
    if (!this.presetsRow) return;
    this.presetsRow.innerHTML = '';
    for (const p of this.presets) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'console-preset';
      b.textContent = p.label;
      b.title = p.command;
      // Presets are inserted into the input line (not auto-run) so users can edit.
      b.addEventListener('click', () => this._setLine(p.command));
      this.presetsRow.appendChild(b);
    }
  }

  // --- Input line editing -------------------------------------------------

  /**
   * Single entry point for all keyboard / paste input from xterm.
   *
   * `data` is whatever the terminal emits: a single keypress, a control
   * sequence (arrow keys, Home/End, …) or a whole chunk of pasted text. We
   * keep a full line buffer (`this.line`) plus a cursor position
   * (`this.cursor`) so the line can be edited like in a real terminal:
   * insert/delete anywhere, move with the arrows, copy a selection, etc.
   */
  _onData(data) {
    if (this.running) {
      if (data === '\u0003') this.stop(); // Ctrl+C aborts the running command
      return;
    }

    // Recognised control sequences / shortcuts (each arrives as its own chunk).
    switch (data) {
      case '\x1b[A': this._historyPrev(); return;            // Up
      case '\x1b[B': this._historyNext(); return;            // Down
      case '\x1b[C': this._cursorRight(); return;            // Right
      case '\x1b[D': this._cursorLeft(); return;            // Left
      case '\x1b[H': case '\x1bOH': case '\x1b[1~': case '\x01': // Home / Ctrl+A
        this._cursorHome(); return;
      case '\x1b[F': case '\x1bOF': case '\x1b[4~': case '\x05': // End / Ctrl+E
        this._cursorEnd(); return;
      case '\x1b[3~': this._deleteAtCursor(); return;        // Delete
      case '\x15': this._killToStart(); return;              // Ctrl+U
      case '\x0b': this._killToEnd(); return;                // Ctrl+K
      case '\x17': case '\x1b\x7f': this._deleteWord(); return; // Ctrl+W / Alt+Backspace
      default: break;
    }

    // Everything else: a keypress or pasted text. Walk the characters so a
    // multi-line paste runs each complete line, exactly like a real shell.
    let chunk = '';
    const flush = () => { if (chunk) { this._insert(chunk); chunk = ''; } };
    for (const ch of data) {
      const code = ch.codePointAt(0);
      if (ch === '\r' || ch === '\n') { flush(); this._submitLine(); }
      else if (ch === '\u007f' || ch === '\b') { flush(); this._backspace(); }
      else if (ch === '\u0003') { flush(); this._copyOrCancel(); }
      else if (code >= 32 && code !== 127) { chunk += ch; }
      // Other control characters are ignored.
    }
    flush();
  }

  /** Insert `text` at the cursor, redrawing the tail of the line. */
  _insert(text) {
    const after = this.line.slice(this.cursor);
    this.line = this.line.slice(0, this.cursor) + text + after;
    this.cursor += text.length;
    this.term.write(text + after);
    if (after.length) this.term.write('\x1b[' + after.length + 'D');
  }

  /** Delete the character before the cursor (Backspace). */
  _backspace() {
    if (this.cursor === 0) return;
    const after = this.line.slice(this.cursor);
    this.line = this.line.slice(0, this.cursor - 1) + after;
    this.cursor -= 1;
    this.term.write('\b' + after + ' ' + '\x1b[' + (after.length + 1) + 'D');
  }

  /** Delete the character at the cursor (Delete key). */
  _deleteAtCursor() {
    if (this.cursor >= this.line.length) return;
    const after = this.line.slice(this.cursor + 1);
    this.line = this.line.slice(0, this.cursor) + after;
    this.term.write(after + ' ' + '\x1b[' + (after.length + 1) + 'D');
  }

  _cursorLeft() {
    if (this.cursor <= 0) return;
    this.cursor -= 1;
    this.term.write('\x1b[D');
  }

  _cursorRight() {
    if (this.cursor >= this.line.length) return;
    this.cursor += 1;
    this.term.write('\x1b[C');
  }

  _cursorHome() {
    if (this.cursor <= 0) return;
    this.term.write('\x1b[' + this.cursor + 'D');
    this.cursor = 0;
  }

  _cursorEnd() {
    const d = this.line.length - this.cursor;
    if (d <= 0) return;
    this.term.write('\x1b[' + d + 'C');
    this.cursor = this.line.length;
  }

  /** Ctrl+U: delete everything before the cursor. */
  _killToStart() {
    if (this.cursor === 0) return;
    const n = this.cursor;
    const after = this.line.slice(this.cursor);
    this.line = after;
    this.cursor = 0;
    this.term.write('\x1b[' + n + 'D' + after + ' '.repeat(n) + '\x1b[' + (after.length + n) + 'D');
  }

  /** Ctrl+K: delete everything from the cursor to the end of the line. */
  _killToEnd() {
    const n = this.line.length - this.cursor;
    if (n <= 0) return;
    this.line = this.line.slice(0, this.cursor);
    this.term.write(' '.repeat(n) + '\x1b[' + n + 'D');
  }

  /** Ctrl+W / Alt+Backspace: delete the word before the cursor. */
  _deleteWord() {
    if (this.cursor === 0) return;
    let start = this.cursor;
    while (start > 0 && this.line[start - 1] === ' ') start -= 1;
    while (start > 0 && this.line[start - 1] !== ' ') start -= 1;
    const removed = this.cursor - start;
    const after = this.line.slice(this.cursor);
    this.line = this.line.slice(0, start) + after;
    this.cursor = start;
    this.term.write('\x1b[' + removed + 'D' + after + ' '.repeat(removed)
      + '\x1b[' + (after.length + removed) + 'D');
  }

  /** Copy xterm's logical selection, including a fallback for restricted iframes. */
  async _copySelection() {
    const selection = this.term?.getSelection?.() || '';
    if (!selection) return false;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(selection);
        copied = true;
      }
    } catch { /* restricted iframe: use the legacy selection fallback below */ }
    if (!copied) {
      const helper = document.createElement('textarea');
      helper.value = selection;
      helper.setAttribute('readonly', '');
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      try { copied = document.execCommand('copy'); } catch { copied = false; }
      helper.remove();
      this.term?.focus?.();
    }
    if (copied) {
      this.toasts?.success?.(this._t('console.copied', 'Console text copied to clipboard'));
      return true;
    }
    this.toasts?.error?.(this._t('console.copy_failed', 'Could not copy console text'));
    return false;
  }

  /** Ctrl+C: copy the active selection if any, otherwise cancel the line. */
  _copyOrCancel() {
    if (this.term?.hasSelection?.()) {
      this._copySelection();
      return;
    }
    this._cancelLine();
  }

  _cancelLine() {
    this._cursorEnd();
    this.term.write('^C');
    this.line = '';
    this.cursor = 0;
    this.term.write('\r\n');
    this.promptActive = false;
    this._writePrompt();
  }

  _setLine(text) {
    if (!this.term || this.running) return;
    this._clearLine();
    this.line = String(text);
    this.cursor = this.line.length;
    this.term.write(this.line);
    this.term.focus();
  }

  /** Visually erase the current input line and reset the buffer. */
  _clearLine() {
    this._cursorEnd();
    const n = this.line.length;
    if (n > 0) this.term.write('\b'.repeat(n) + ' '.repeat(n) + '\x1b[' + n + 'D');
    this.line = '';
    this.cursor = 0;
  }

  _submitLine() {
    const cmd = this.line;
    this.line = '';
    this.cursor = 0;
    this.term.write('\r\n');
    this.promptActive = false;
    const trimmed = cmd.trim();
    if (trimmed === '') { this._writePrompt(); return; }
    this.history.push(trimmed);
    this.historyIndex = this.history.length;
    this._persistHistory();
    this.run(trimmed, { fromInput: true });
  }

  _historyPrev() {
    if (this.history.length === 0) return;
    this.historyIndex = Math.max(0, this.historyIndex - 1);
    this._setLine(this.history[this.historyIndex] || '');
  }

  _historyNext() {
    if (this.history.length === 0) return;
    this.historyIndex = Math.min(this.history.length, this.historyIndex + 1);
    this._setLine(this.historyIndex >= this.history.length ? '' : this.history[this.historyIndex]);
  }

  _writePrompt() {
    if (!this.term) return;
    this.term.write(this._prompt());
    this.promptActive = true;
  }

  _prompt() {
    // Bold green marker normally, red after a failed command.
    return this.lastFailed ? '\x1b[1;31m$\x1b[0m ' : '\x1b[1;32m$\x1b[0m ';
  }

  _writeCommandSeparator(command = '') {
    if (!this.term) return;
    this.commandBlockIndex += 1;
    const label = command ? ' ' + command + ' ' : ' command ';
    const cols = Math.max(24, this.term.cols || 80);
    const innerWidth = Math.max(0, cols - 4);
    const title = '[' + this.commandBlockIndex + ']' + label;
    const fill = Math.max(0, innerWidth - title.length);
    const left = '─'.repeat(Math.floor(fill / 2));
    const right = '─'.repeat(Math.ceil(fill / 2));
    this.term.write('\x1b[90m');
    this.term.write('┌' + left + title + right + '┐\r\n');
    this.term.write('\x1b[0m');
  }

  _writeCommandFooter() {
    if (!this.term) return;
    const cols = Math.max(24, this.term.cols || 80);
    this.term.write('\x1b[90m' + '└' + '─'.repeat(Math.max(0, cols - 2)) + '┘' + '\x1b[0m\r\n\r\n');
  }

  // --- Public entry points ------------------------------------------------

  /**
   * Run a command and stream its output.
   * @param {string} command
   * @param {{ fromInput?:boolean, autoOpen?:boolean }} [opts]
   */
  run(command, opts = {}) {
    command = (command || '').trim();
    if (!command) return;
    if (opts.autoOpen) this.open();
    this._schedule(() => this._doRun(command, opts));
  }

  /**
   * Echo an already-executed CLI block without running anything.
   * @param {{ command?:string, output?:string, exit_code?:number, ok?:boolean }} block
   * @param {{ autoOpen?:boolean }} [opts]
   */
  inject(block, opts = {}) {
    if (!block) return;
    const failed = block.ok === false;
    if (opts.autoOpen || failed) this.open();
    this._schedule(() => this._doInject(block));
  }

  async _doRun(command, opts) {
    this._writeCommandSeparator(command);
    if (!opts.fromInput) {
      // Programmatic run: echo the command so users see what executed.
      if (this.promptActive) { this.term.write('\r\n'); this.promptActive = false; }
      this.term.write(this._prompt() + command + '\r\n');
    }
    this._setRunning(true);
    this.abort = new AbortController();
    let failed = false;
    try {
      await this.client.runStream(
        { command },
        { signal: this.abort.signal, onChunk: (t) => this.term.write(t) }
      );
    } catch (e) {
      if (e?.name === 'AbortError') {
        this.term.write('\r\n\x1b[33m[stopped]\x1b[0m\r\n');
      } else {
        failed = true;
        this.term.write('\r\n\x1b[31m' + (e?.message || 'Command failed') + '\x1b[0m\r\n');
      }
    } finally {
      this.abort = null;
      this.lastFailed = failed;
      this._setRunning(false);
      this._writeCommandFooter();
      if (failed) this.open();
      this._writePrompt();
      this._drainQueue();
    }
  }

  _doInject(block) {
    const command = block.command || '';
    this._writeCommandSeparator(command);
    if (this.promptActive) { this.term.write('\r\n'); this.promptActive = false; }
    if (command) this.term.write(this._prompt() + command + '\r\n');
    let output = block.output != null ? String(block.output) : '';
    if (output && !output.endsWith('\n')) output += '\n';
    if (output) this.term.write(output.replace(/\r?\n/g, '\r\n'));
    this.lastFailed = block.ok === false;
    this._writeCommandFooter();
    this._writePrompt();
  }

  stop() {
    if (this.abort) {
      try { this.abort.abort(); } catch { /* already aborted */ }
    }
  }

  // --- State helpers ------------------------------------------------------

  _setRunning(running) {
    this.running = running;
    if (this.stopBtn) this.stopBtn.disabled = !running;
    if (this.statusEl) {
      this.statusEl.classList.toggle('is-running', running);
      this.statusEl.classList.toggle('is-idle', !running && !this.lastFailed);
      this.statusEl.classList.toggle('is-failed', !running && this.lastFailed);
      if (running) {
        this.statusEl.textContent = this._t('console.running', 'Running…');
      } else {
        this.statusEl.textContent = this.lastFailed
          ? this._t('console.failed', 'Failed')
          : this._t('console.idle', 'Idle');
      }
    }
  }

  /** Run `action` now if idle and ready; otherwise queue it. */
  _schedule(action) {
    if (this.ready && !this.running) { action(); return; }
    this.queue.push(action);
  }

  _drainQueue() {
    if (!this.ready || this.running) return;
    const action = this.queue.shift();
    if (action) action();
  }

  // --- Persistence + i18n -------------------------------------------------

  _historyKey() {
    const alias = window.CODIWARE_BOOT?.workspace?.alias || 'default';
    return 'codiware.console.history.' + alias;
  }

  _loadHistory() {
    try {
      const raw = window.localStorage.getItem(this._historyKey());
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
    } catch { return []; }
  }

  _persistHistory() {
    try {
      const trimmed = this.history.slice(-100);
      window.localStorage.setItem(this._historyKey(), JSON.stringify(trimmed));
    } catch { /* storage unavailable */ }
  }

  _t(key, fallback) {
    const v = this.i18n?.t?.(key);
    return v && v !== key ? v : fallback;
  }
}
