/** Bottom console panel for running whitelisted commands. */
import { Icon } from '../core/Icon.js';

export class ConsolePanel {
  constructor({ api, i18n, toasts }) {
    this.api = api; this.i18n = i18n; this.toasts = toasts;
    this.presets = [];
  }

  async mount(host) {
    this.host = host;
    host.innerHTML = '';

    const presetsRow = document.createElement('div');
    presetsRow.style.display = 'flex';
    presetsRow.style.gap = '4px';
    presetsRow.style.padding = '4px';
    presetsRow.style.borderBottom = '1px solid var(--ide-border)';
    presetsRow.style.overflowX = 'auto';
    this.presetsRow = presetsRow;

    this.output = document.createElement('div');
    this.output.className = 'console-output';

    const inputRow = document.createElement('div');
    inputRow.className = 'console-input-row';
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.placeholder = this.i18n.t('console.placeholder');
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.runCommand(this.input.value); });
    const runBtn = document.createElement('button');
    runBtn.title = this.i18n.t('console.run');
    runBtn.append(Icon.render('fa fa-play'));
    runBtn.addEventListener('click', () => this.runCommand(this.input.value));
    inputRow.append(this.input, runBtn);

    host.append(presetsRow, this.output, inputRow);

    try {
      const data = await this.api.get('/console/presets');
      this.presets = data?.presets || [];
      this._renderPresets();
    } catch (e) { this.toasts.error(e.message); }
  }

  _renderPresets() {
    this.presetsRow.innerHTML = '';
    for (const p of this.presets) {
      const b = document.createElement('button');
      b.textContent = p.label;
      b.title = p.command;
      b.addEventListener('click', () => this.runPreset(p.label));
      this.presetsRow.appendChild(b);
    }
  }

  async runPreset(label) {
    this._echo(`▶ [${label}]`);
    try {
      const r = await this.api.post('/console/run', { preset: label });
      this._writeResult(r);
    } catch (e) { this._echo(`✖ ${e.message}`); }
  }

  async runCommand(cmd) {
    cmd = cmd.trim();
    if (!cmd) return;
    this._echo(`$ ${cmd}`);
    this.input.value = '';
    try {
      const r = await this.api.post('/console/run', { command: cmd });
      this._writeResult(r);
    } catch (e) { this._echo(`✖ ${e.message}`); }
  }

  _writeResult(r) {
    if (r.stdout) this._echo(r.stdout);
    if (r.stderr) this._echo(r.stderr);
    if (r.timed_out) this._echo('[command timed out]');
    this._echo(`[exit ${r.exit_code}]`);
  }

  _echo(text) {
    const div = document.createElement('div');
    div.textContent = text;
    this.output.appendChild(div);
    this.output.scrollTop = this.output.scrollHeight;
  }
}
