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
    const s = document.createElement('script');
    s.src = npmBase + XTERM_JS + suffix;
    s.async = true;
    s.onload = () => (window.Terminal
      ? resolve(window.Terminal)
      : reject(new Error('xterm loaded but window.Terminal is undefined')));
    s.onerror = () => reject(new Error('Failed to load xterm from ' + s.src));
    document.head.appendChild(s);
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
    this.running = false;
    this.abort = null;
    this.lastFailed = false;
    this.promptActive = false;

    this.term = null;
    this.ready = false;
    this.queue = [];

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
      theme,
    });
    this.term.open(this.termEl);
    this._fit();

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

  _onData(data) {
    if (this.running) {
      if (data === '\u0003') this.stop(); // Ctrl+C
      return;
    }
    if (data === '\x1b[A') { this._historyPrev(); return; }
    if (data === '\x1b[B') { this._historyNext(); return; }
    if (data === '\x1b[C' || data === '\x1b[D') return; // ignore left/right
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') { this._submitLine(); }
      else if (ch === '\u007f' || ch === '\b') { this._backspace(); }
      else if (ch === '\u0003') { this._cancelLine(); }
      else if (ch.charCodeAt(0) >= 32) { this.line += ch; this.term.write(ch); }
    }
  }

  _backspace() {
    if (this.line.length === 0) return;
    this.line = this.line.slice(0, -1);
    this.term.write('\b \b');
  }

  _cancelLine() {
    this.term.write('^C');
    this.line = '';
    this.term.write('\r\n');
    this.promptActive = false;
    this._writePrompt();
  }

  _setLine(text) {
    if (!this.term || this.running) return;
    // Clear the current line content, then write the new text.
    while (this.line.length > 0) this._backspace();
    this.line = String(text);
    this.term.write(this.line);
    this.term.focus();
  }

  _submitLine() {
    const cmd = this.line;
    this.line = '';
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
      if (failed) this.open();
      this._writePrompt();
      this._drainQueue();
    }
  }

  _doInject(block) {
    if (this.promptActive) { this.term.write('\r\n'); this.promptActive = false; }
    const command = block.command || '';
    if (command) this.term.write(this._prompt() + command + '\r\n');
    let output = block.output != null ? String(block.output) : '';
    if (output && !output.endsWith('\n')) output += '\n';
    if (output) this.term.write(output.replace(/\r?\n/g, '\r\n'));
    this.lastFailed = block.ok === false;
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

