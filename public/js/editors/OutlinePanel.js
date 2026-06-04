/**
 * Outline panel for Monaco editor. Shows document symbols (classes, methods,
 * functions, etc.) in a tree structure and allows navigation by clicking.
 * 
 * Uses Monaco's built-in DocumentSymbol provider to extract symbols from the
 * current model.
 */
export class OutlinePanel {
  constructor({ container, i18n }) {
    this.container = container;
    this.i18n = i18n;
    this._editor = null;
    this._monaco = null;
    this._symbolCache = [];
    this._disposed = false;
    this._updateTimeout = null;
    
    this._build();
  }

  _build() {
    this.container.innerHTML = '';
    this.container.className = 'outline-panel';
    
    // Header
    const header = document.createElement('div');
    header.className = 'outline-header';
    header.textContent = this.i18n?.t('outline.title') || 'Outline';
    this.container.appendChild(header);

    // Symbol tree container
    this._tree = document.createElement('div');
    this._tree.className = 'outline-tree';
    this.container.appendChild(this._tree);

    // Empty state
    this._emptyMsg = document.createElement('div');
    this._emptyMsg.className = 'outline-empty';
    this._emptyMsg.textContent = this.i18n?.t('outline.no_symbols') || 'No symbols found';
    this._emptyMsg.style.display = 'none';
    this.container.appendChild(this._emptyMsg);
  }

  /**
   * Attach to a Monaco editor instance.
   */
  attach(editor, monaco) {
    this._editor = editor;
    this._monaco = monaco;
    
    // Update outline when model changes
    this._modelListener = editor.onDidChangeModel(() => this._scheduleUpdate());
    this._contentListener = editor.onDidChangeModelContent(() => this._scheduleUpdate());
    
    this._scheduleUpdate();
  }

  _scheduleUpdate() {
    if (this._disposed) return;
    clearTimeout(this._updateTimeout);
    // Debounce updates to avoid too frequent refreshes
    this._updateTimeout = setTimeout(() => this._updateOutline(), 250);
  }

  async _updateOutline() {
    if (this._disposed || !this._editor || !this._monaco) return;
    
    const model = this._editor.getModel();
    if (!model) {
      this._showEmpty();
      return;
    }

    try {
      // Parse symbols using regex patterns - works for all languages
      const symbols = this._parseBasicSymbols(model);
      this._symbolCache = symbols;
      
      if (symbols.length === 0) {
        this._showEmpty();
      } else {
        this._renderSymbols(symbols);
      }
    } catch (e) {
      console.warn('[outline] Failed to get symbols:', e);
      this._showEmpty();
    }
  }

  /**
   * Parser for extracting symbols from source code using regex patterns.
   * Extracts function/method/class declarations for common languages.
   */
  _parseBasicSymbols(model) {
    const language = model.getLanguageId();
    const content = model.getValue();
    const symbols = [];
    const SymbolKind = this._monaco.languages.SymbolKind;

    // SQL outline is comment-driven: every comment-starting line becomes an item.
    if (language === 'sql') {
      return this._parseSqlCommentSymbols(content, SymbolKind);
    }

    // JSON outline shows only top-level object keys.
    if (language === 'json') {
      return this._parseJsonTopLevelKeys(content, SymbolKind);
    }

    const patterns = {
      php: [
        // Classes (with optional abstract/final)
        { regex: /^[ \t]*(?:abstract[ \t]+|final[ \t]+)?class[ \t]+(\w+)/gm, kind: SymbolKind.Class },
        // Interfaces
        { regex: /^[ \t]*interface[ \t]+(\w+)/gm, kind: SymbolKind.Interface },
        // Traits  
        { regex: /^[ \t]*trait[ \t]+(\w+)/gm, kind: SymbolKind.Class },
        // Methods and functions (with optional visibility/static/abstract)
        { regex: /^[ \t]*(?:(?:public|private|protected|static|abstract|final)[ \t]+)*function[ \t]+(\w+)[ \t]*\(/gm, kind: SymbolKind.Method },
        // Class constants
        { regex: /^[ \t]*(?:(?:public|private|protected)[ \t]+)?const[ \t]+(\w+)[ \t]*=/gm, kind: SymbolKind.Constant },
      ],
      javascript: [
        { regex: /^[ \t]*(?:export[ \t]+)?(?:async[ \t]+)?function[ \t]+(\w+)[ \t]*\(/gm, kind: SymbolKind.Function },
        { regex: /^[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+(\w+)[ \t]*=[ \t]*(?:async[ \t]+)?(?:function|\([^)]*\)[ \t]*=>|\w+[ \t]*=>)/gm, kind: SymbolKind.Function },
        { regex: /^[ \t]*(?:export[ \t]+)?class[ \t]+(\w+)/gm, kind: SymbolKind.Class },
        // Class methods
        { regex: /^[ \t]*(?:async[ \t]+)?(\w+)[ \t]*\([^)]*\)[ \t]*{/gm, kind: SymbolKind.Method },
      ],
      typescript: [
        { regex: /^[ \t]*(?:export[ \t]+)?(?:async[ \t]+)?function[ \t]+(\w+)[ \t]*[<(]/gm, kind: SymbolKind.Function },
        { regex: /^[ \t]*(?:export[ \t]+)?(?:abstract[ \t]+)?class[ \t]+(\w+)/gm, kind: SymbolKind.Class },
        { regex: /^[ \t]*(?:export[ \t]+)?interface[ \t]+(\w+)/gm, kind: SymbolKind.Interface },
        { regex: /^[ \t]*(?:export[ \t]+)?type[ \t]+(\w+)[ \t]*[=<]/gm, kind: SymbolKind.TypeParameter },
        { regex: /^[ \t]*(?:export[ \t]+)?enum[ \t]+(\w+)/gm, kind: SymbolKind.Enum },
        // Class methods
        { regex: /^[ \t]*(?:(?:public|private|protected|static|async)[ \t]+)*(\w+)[ \t]*\([^)]*\)(?:[ \t]*:[ \t]*\w+)?[ \t]*{/gm, kind: SymbolKind.Method },
      ],
      python: [
        { regex: /^[ \t]*def[ \t]+(\w+)[ \t]*\(/gm, kind: SymbolKind.Function },
        { regex: /^[ \t]*class[ \t]+(\w+)/gm, kind: SymbolKind.Class },
      ],
      json: [], // No symbols for JSON
      markdown: [], // No symbols for Markdown
    };

    const langPatterns = patterns[language] || patterns.javascript || [];
    const lines = content.split('\n');
    const seen = new Set(); // Avoid duplicates

    for (const { regex, kind } of langPatterns) {
      let match;
      regex.lastIndex = 0;
      while ((match = regex.exec(content)) !== null) {
        const name = match[1];
        // Skip common false positives
        if (!name || name === 'function' || name === 'class' || name === 'if' || 
            name === 'for' || name === 'while' || name === 'switch' || name === 'catch' ||
            name === 'return' || name === 'new' || name === 'else') continue;
        
        // Find line number
        const beforeMatch = content.substring(0, match.index);
        const lineNumber = beforeMatch.split('\n').length;
        
        // Create unique key to avoid duplicates
        const key = `${name}:${lineNumber}`;
        if (seen.has(key)) continue;
        seen.add(key);
        
        symbols.push({
          name,
          kind,
          depth: 0,
          range: {
            startLineNumber: lineNumber,
            startColumn: 1,
            endLineNumber: lineNumber,
            endColumn: lines[lineNumber - 1]?.length || 1,
          },
          selectionRange: {
            startLineNumber: lineNumber,
            startColumn: match.index - beforeMatch.lastIndexOf('\n'),
            endLineNumber: lineNumber,
            endColumn: (match.index - beforeMatch.lastIndexOf('\n')) + match[0].length,
          },
        });
      }
    }

    // Sort by line number
    symbols.sort((a, b) => a.range.startLineNumber - b.range.startLineNumber);
    return symbols;
  }

  /**
   * Build an outline for SQL files from comments.
   * - Every line that starts with a single-line comment marker is listed.
   * - Multi-line block comments are represented once by their first line.
   * - Captions are truncated to a single short line for compact display.
   */
  _parseSqlCommentSymbols(content, SymbolKind) {
    const lines = content.split('\n');
    const symbols = [];
    const maxLen = 30;
    let inBlockComment = false;

    const toSingleLine = (text) => {
      const normalized = (text || '').replace(/\s+/g, ' ').trim();
      if (!normalized) return '';
      if (normalized.length <= maxLen) return normalized;
      return normalized.slice(0, maxLen).trimEnd() + '...';
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || '';
      const lineNumber = i + 1;
      const trimmed = line.trimStart();
      const firstNonWs = line.length - trimmed.length;

      if (inBlockComment) {
        if (trimmed.includes('*/')) {
          inBlockComment = false;
        }
        continue;
      }

      if (trimmed.startsWith('--')) {
        const raw = trimmed.slice(2);
        const name = toSingleLine(raw);
        symbols.push({
          name,
          kind: SymbolKind.String,
          isSqlComment: true,
          depth: 0,
          range: {
            startLineNumber: lineNumber,
            startColumn: firstNonWs + 1,
            endLineNumber: lineNumber,
            endColumn: line.length + 1,
          },
          selectionRange: {
            startLineNumber: lineNumber,
            startColumn: firstNonWs + 1,
            endLineNumber: lineNumber,
            endColumn: line.length + 1,
          },
        });
        continue;
      }

      if (trimmed.startsWith('#')) {
        const raw = trimmed.slice(1);
        const name = toSingleLine(raw);
        symbols.push({
          name,
          kind: SymbolKind.String,
          isSqlComment: true,
          depth: 0,
          range: {
            startLineNumber: lineNumber,
            startColumn: firstNonWs + 1,
            endLineNumber: lineNumber,
            endColumn: line.length + 1,
          },
          selectionRange: {
            startLineNumber: lineNumber,
            startColumn: firstNonWs + 1,
            endLineNumber: lineNumber,
            endColumn: line.length + 1,
          },
        });
        continue;
      }

      if (trimmed.startsWith('/*')) {
        const closeIdx = trimmed.indexOf('*/', 2);
        const raw = closeIdx >= 0 ? trimmed.slice(2, closeIdx) : trimmed.slice(2);
        const name = toSingleLine(raw);

        symbols.push({
          name,
          kind: SymbolKind.String,
          isSqlComment: true,
          depth: 0,
          range: {
            startLineNumber: lineNumber,
            startColumn: firstNonWs + 1,
            endLineNumber: lineNumber,
            endColumn: line.length + 1,
          },
          selectionRange: {
            startLineNumber: lineNumber,
            startColumn: firstNonWs + 1,
            endLineNumber: lineNumber,
            endColumn: line.length + 1,
          },
        });

        if (closeIdx < 0) {
          inBlockComment = true;
        }
      }
    }

    return symbols;
  }

  /**
   * Build an outline for JSON files from top-level object keys.
   */
  _parseJsonTopLevelKeys(content, SymbolKind) {
    const trimmed = content.trimStart();
    if (!trimmed.startsWith('{')) {
      return [];
    }

    const symbols = [];
    let rowsSymbolIndex = -1;
    let i = 0;
    let line = 1;
    let col = 1;
    let objectDepth = 0;
    let expectingTopKey = false;

    const len = content.length;

    const advance = () => {
      const ch = content[i];
      i += 1;
      if (ch === '\n') {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
      return ch;
    };

    const skipWhitespace = () => {
      while (i < len) {
        const ch = content[i];
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
          advance();
          continue;
        }
        break;
      }
    };

    const parseStringToken = () => {
      if (content[i] !== '"') return null;
      const startLine = line;
      const startCol = col;
      advance(); // opening quote

      let value = '';
      let escaped = false;

      while (i < len) {
        const ch = advance();
        if (escaped) {
          value += ch;
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          return { value, startLine, startCol, endLine: line, endCol: col };
        }
        value += ch;
      }

      return null;
    };

    while (i < len) {
      skipWhitespace();
      if (i >= len) break;

      const ch = content[i];

      if (ch === '{') {
        advance();
        objectDepth += 1;
        if (objectDepth === 1) {
          expectingTopKey = true;
        }
        continue;
      }

      if (ch === '}') {
        advance();
        if (objectDepth === 1) {
          expectingTopKey = false;
        }
        objectDepth = Math.max(0, objectDepth - 1);
        continue;
      }

      if (ch === ',') {
        advance();
        if (objectDepth === 1) {
          expectingTopKey = true;
        }
        continue;
      }

      if (expectingTopKey && objectDepth === 1 && ch === '"') {
        const keyToken = parseStringToken();
        if (!keyToken) break;

        const afterKeyLine = line;
        const afterKeyCol = col;
        skipWhitespace();

        if (content[i] === ':') {
          const symbol = {
            name: keyToken.value,
            kind: SymbolKind.Property,
            depth: 0,
            range: {
              startLineNumber: keyToken.startLine,
              startColumn: keyToken.startCol,
              endLineNumber: keyToken.endLine,
              endColumn: keyToken.endCol,
            },
            selectionRange: {
              startLineNumber: keyToken.startLine,
              startColumn: keyToken.startCol,
              endLineNumber: keyToken.endLine,
              endColumn: keyToken.endCol,
            },
          };
          if (keyToken.value === 'rows') {
            rowsSymbolIndex = symbols.length;
          }
          symbols.push(symbol);
          expectingTopKey = false;
          advance(); // ':'
          continue;
        }

        // Invalid key token position: restore to continue scanning safely.
        line = afterKeyLine;
        col = afterKeyCol;
        continue;
      }

      if (ch === '"') {
        // Skip non-key strings safely.
        parseStringToken();
        continue;
      }

      advance();
    }

    return this._appendRowsExportSummaryItems(content, symbols, rowsSymbolIndex, SymbolKind);
  }

  _appendRowsExportSummaryItems(content, symbols, rowsSymbolIndex, SymbolKind) {
    if (rowsSymbolIndex < 0) {
      return symbols;
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return symbols;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.rows)) {
      return symbols;
    }

    const values = parsed.rows
      .map((row) => {
        if (!row || typeof row !== 'object') {
          return undefined;
        }
        return Object.prototype.hasOwnProperty.call(row, '_EXPORT_SUMMARY') ? row._EXPORT_SUMMARY : undefined;
      })
      .filter((value) => value !== undefined && value !== null);

    if (values.length === 0) {
      return symbols;
    }

    const truncate = (value) => {
      const text = String(value).replace(/\s+/g, ' ').trim();
      if (text.length <= 30) {
        return text;
      }
      return text.slice(0, 30).trimEnd() + '...';
    };

    const rowsRange = this._findTopLevelRowsArrayRange(content);
    if (!rowsRange) {
      return symbols;
    }

    const occurrences = [];
    const regex = /"_EXPORT_SUMMARY"\s*:/g;
    regex.lastIndex = rowsRange.start;
    let match;
    while ((match = regex.exec(content)) !== null) {
      if (match.index > rowsRange.end) {
        break;
      }
      const before = content.slice(0, match.index);
      const startLineNumber = before.split('\n').length;
      const startColumn = match.index - before.lastIndexOf('\n');
      occurrences.push({ startLineNumber, startColumn });
    }

    if (occurrences.length === 0) {
      return symbols;
    }

    const count = Math.min(values.length, occurrences.length);
    const children = [];
    for (let i = 0; i < count; i++) {
      const pos = occurrences[i];
      children.push({
        name: truncate(values[i]).trimStart(),
        kind: SymbolKind.String,
        isPlainTextItem: true,
        depth: 1,
        range: {
          startLineNumber: pos.startLineNumber,
          startColumn: pos.startColumn,
          endLineNumber: pos.startLineNumber,
          endColumn: pos.startColumn + 1,
        },
        selectionRange: {
          startLineNumber: pos.startLineNumber,
          startColumn: pos.startColumn,
          endLineNumber: pos.startLineNumber,
          endColumn: pos.startColumn + 1,
        },
      });
    }

    symbols.splice(rowsSymbolIndex + 1, 0, ...children);
    return symbols;
  }

  _findTopLevelRowsArrayRange(content) {
    const rowsKeyMatch = /"rows"\s*:/g.exec(content);
    if (!rowsKeyMatch) {
      return null;
    }

    let i = rowsKeyMatch.index + rowsKeyMatch[0].length;
    const len = content.length;

    while (i < len && /\s/.test(content[i])) {
      i++;
    }
    if (content[i] !== '[') {
      return null;
    }

    const start = i;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (; i < len; i++) {
      const ch = content[i];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '[') {
        depth++;
        continue;
      }

      if (ch === ']') {
        depth--;
        if (depth === 0) {
          return { start, end: i };
        }
      }
    }

    return null;
  }

  _showEmpty() {
    this._tree.style.display = 'none';
    this._emptyMsg.style.display = '';
  }

  _renderSymbols(symbols) {
    this._tree.innerHTML = '';
    this._tree.style.display = '';
    this._emptyMsg.style.display = 'none';

    for (const sym of symbols) {
      const item = document.createElement('div');
      item.className = 'outline-item';
      item.style.paddingLeft = (8 + sym.depth * 12) + 'px';
      
      const icon = document.createElement('span');
      icon.className = 'outline-icon';
      icon.innerHTML = this._getSymbolIcon(sym.kind);
      
      const name = document.createElement('span');
      name.className = 'outline-name';
      name.textContent = sym.name;
      name.title = sym.name;
      
      const line = document.createElement('span');
      line.className = 'outline-line';
      line.textContent = sym.range?.startLineNumber || '';
        if (sym.isSqlComment || sym.isPlainTextItem) {
          item.append(name, line);
        } else {
          item.append(icon, name, line);
        }
      
      item.addEventListener('click', () => this._goToSymbol(sym));
      
      this._tree.appendChild(item);
    }
  }

  _goToSymbol(sym) {
    if (!this._editor || !sym.range) return;
    
    const range = sym.selectionRange || sym.range;
    this._editor.revealLineInCenter(range.startLineNumber);
    this._editor.setPosition({
      lineNumber: range.startLineNumber,
      column: range.startColumn || 1,
    });
    this._editor.focus();
  }

  _getSymbolIcon(kind) {
    const SymbolKind = this._monaco?.languages?.SymbolKind || {};
    
    // Map symbol kinds to simple icons
    const icons = {
      [SymbolKind.File]: '📄',
      [SymbolKind.Module]: '📦',
      [SymbolKind.Namespace]: '📁',
      [SymbolKind.Package]: '📦',
      [SymbolKind.Class]: '<span style="color:#e0a030">C</span>',
      [SymbolKind.Method]: '<span style="color:#7c7cff">m</span>',
      [SymbolKind.Property]: '◇',
      [SymbolKind.Field]: '◇',
      [SymbolKind.Constructor]: '<span style="color:#e0a030">⬡</span>',
      [SymbolKind.Enum]: 'E',
      [SymbolKind.Interface]: '<span style="color:#5bc0de">I</span>',
      [SymbolKind.Function]: '<span style="color:#7c7cff">ƒ</span>',
      [SymbolKind.Variable]: 'v',
      [SymbolKind.Constant]: '<span style="color:#d04444">c</span>',
      [SymbolKind.String]: '"',
      [SymbolKind.Number]: '#',
      [SymbolKind.Boolean]: '◈',
      [SymbolKind.Array]: '[]',
      [SymbolKind.Object]: '{}',
      [SymbolKind.Key]: '🔑',
      [SymbolKind.Null]: '∅',
      [SymbolKind.EnumMember]: '◆',
      [SymbolKind.Struct]: 'S',
      [SymbolKind.Event]: '⚡',
      [SymbolKind.Operator]: '+',
      [SymbolKind.TypeParameter]: 'T',
    };
    
    return icons[kind] || '<span style="color:#7c7cff">ƒ</span>';
  }

  dispose() {
    this._disposed = true;
    clearTimeout(this._updateTimeout);
    this._modelListener?.dispose();
    this._contentListener?.dispose();
    this.container.innerHTML = '';
  }
}
