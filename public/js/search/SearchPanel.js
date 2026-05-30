/** Workspace-wide search panel. */
export class SearchPanel {
  constructor({ api, i18n, toasts, bus, onOpenLine }) {
    this.api = api; this.i18n = i18n; this.toasts = toasts; this.bus = bus;
    this.onOpenLine = onOpenLine;
  }

  mount(host) {
    this.host = host;
    host.innerHTML = ''; host.classList.add('panel-section');

    this.q = input('search', this.i18n.t('search.placeholder'));
    this.q.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.run(); });

    this.replace = input('text', this.i18n.t('search.replace_with'));

    const optsRow = el('div');
    optsRow.style.display = 'flex'; optsRow.style.gap = '8px'; optsRow.style.alignItems = 'center';
    optsRow.style.fontSize = 'var(--ide-fs-sm)';
    this.regex = checkbox(this.i18n.t('search.regex'));
    this.cs = checkbox(this.i18n.t('search.case'));
    optsRow.append(this.regex.wrap, this.cs.wrap);

    const btnRow = el('div');
    btnRow.style.display = 'flex'; btnRow.style.gap = '4px'; btnRow.style.marginTop = '4px';
    btnRow.append(
      btn(this.i18n.t('search.preview'), () => this.runReplace(false)),
      btn(this.i18n.t('search.apply'), () => this.runReplace(true)),
    );

    this.results = el('div');
    this.results.style.marginTop = '8px';

    host.append(this.q, this.replace, optsRow, btnRow, this.results);
  }

  async run() {
    const q = this.q.value;
    if (!q) return;
    this.results.textContent = '…';
    try {
      const data = await this.api.get('/search', {
        q, regex: this.regex.input.checked ? 1 : 0, case: this.cs.input.checked ? 1 : 0,
      });
      this._renderResults(data);
    } catch (e) {
      this.results.textContent = e.message;
    }
  }

  async runReplace(apply) {
    const q = this.q.value;
    if (!q) return;
    if (apply && !window.confirm('Apply replacement across the workspace?')) return;
    try {
      const data = await this.api.post('/search/replace', {
        q, replacement: this.replace.value, apply,
        regex: this.regex.input.checked, case: this.cs.input.checked,
      });
      this.toasts.success(`${data.total_replacements} match(es) in ${data.changed_files} file(s)`);
      if (apply) this.bus.emit('files:changed');
    } catch (e) { this.toasts.error(e.message); }
  }

  _renderResults(data) {
    this.results.innerHTML = '';
    if (!data.results.length) {
      this.results.textContent = this.i18n.t('search.no_results');
      return;
    }
    const header = el('div');
    header.textContent = `${data.total_matches} match(es) in ${data.total_files} file(s)${data.truncated ? ' (truncated)' : ''}`;
    header.style.color = 'var(--ide-fg-muted)';
    header.style.marginBottom = '4px';
    this.results.appendChild(header);

    for (const file of data.results) {
      const f = el('div', 'search-result-file');
      f.textContent = file.path;
      this.results.appendChild(f);
      for (const m of file.matches) {
        const line = el('div', 'search-result-line');
        const before = m.text.slice(0, m.column - 1);
        const matched = m.text.substr(m.column - 1, m.match.length);
        const after = m.text.slice(m.column - 1 + m.match.length);
        line.append(
          document.createTextNode(`${m.line}:${m.column}  `),
          document.createTextNode(before),
        );
        const mk = document.createElement('mark');
        mk.textContent = matched;
        line.append(mk, document.createTextNode(after));
        line.addEventListener('click', () => this.onOpenLine?.(file.path, m.line, m.column));
        this.results.appendChild(line);
      }
    }
  }
}

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function btn(text, fn) { const b = document.createElement('button'); b.textContent = text; b.addEventListener('click', fn); return b; }
function input(type, placeholder) {
  const i = document.createElement('input');
  i.type = type; i.placeholder = placeholder || '';
  i.style.width = '100%'; i.style.marginBottom = '4px';
  return i;
}
function checkbox(label) {
  const wrap = document.createElement('label');
  wrap.style.display = 'inline-flex'; wrap.style.alignItems = 'center'; wrap.style.gap = '4px';
  const input = document.createElement('input'); input.type = 'checkbox';
  wrap.append(input, document.createTextNode(label));
  return { wrap, input };
}
