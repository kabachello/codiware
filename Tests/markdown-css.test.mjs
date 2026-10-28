import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../public/js/editors/MarkdownEditor.js', import.meta.url), 'utf8');
const { MarkdownEditor, markdownEditorDescriptor } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const shell = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('shell loads only shared UI styles while Markian owns its editor assets', () => {
  const script = [...shell.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1];
  const links = [];
  const window = { CODIWARE_BOOT: { url_to_app: '/public', url_to_npm: '/vendor/npm-asset' } };
  runInNewContext(script, { window, document: { createElement: () => ({}), head: { appendChild: element => links.push(element) } } });
  assert.deepEqual(links.map(link => link.id), ['codiware-css-fa', 'codiware-css-base', 'codiware-css-light', 'codiware-css-dark']);
});

test('Markian forwards vendor-relative content and theme CSS with the host base and cache version', async () => {
  const links = [];
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    CODIWARE_BOOT: {
      url_base: '/installation', url_to_npm: '/vendor/npm-asset', cache_bust: 'test-version',
      extensions: { 'codiware.markdown': {
        'INCLUDES.MARKIAN_JS': '/vendor/axenox/markian/dist/markian.min.js',
        'INCLUDES.MARKIAN_CSS': '/vendor/axenox/markian/dist/markian.css',
        'INCLUDES.MERMAID_JS': 'vendor/host/mermaid.min.js',
        'INCLUDES.PREVIEW_CSS': ['npm-asset/github-markdown-css/github-markdown.css', 'exface/core/Facades/DocsFacade/template.css'],
        'INCLUDES.THEME_CSS': ['axenox/ide/editor-theme.css'],
      } },
    },
    Markian: { create() {}, registerExtension() {} },
    MarkianCode: { codeExtension() {} },
    MarkianMermaid: { mermaidExtension() {} },
  };
  globalThis.document = {
    baseURI: 'https://host.invalid/installation/',
    createElement: () => ({ remove() {} }),
    head: { append: element => { links.push(element); queueMicrotask(() => element.onload()); } },
  };
  try {
    const host = { replaceChildren() {}, style: {} };
    const editor = markdownEditorDescriptor.create(host, { api: { base: '/installation/api/ide/codiware' } });
    await editor._initPromise;
    assert.ok(editor instanceof MarkdownEditor);
    assert.deepEqual(editor.markdownCssUrls, [
      '/installation/vendor/npm-asset/github-markdown-css/github-markdown.css?v=test-version',
      '/installation/vendor/exface/core/Facades/DocsFacade/template.css?v=test-version',
    ]);
    assert.deepEqual(editor.themeCssUrls, ['/installation/vendor/kabachello/codiware/public/css/markian-theme.css?v=test-version', '/installation/vendor/axenox/ide/editor-theme.css?v=test-version']);
    assert.deepEqual(links.map(link => link.src || link.href), [
      '/vendor/axenox/markian/dist/markian.min.js?v=test-version',
      '/vendor/axenox/markian/dist/markian.css?v=test-version',
      'https://host.invalid/vendor/axenox/markian/dist/extensions/code.min.js?v=test-version',
      'https://host.invalid/vendor/axenox/markian/dist/extensions/mermaid.min.js?v=test-version',
      'https://host.invalid/vendor/axenox/markian/dist/extensions/mermaid.css?v=test-version',
    ]);
    assert.deepEqual(editor.extensions.code, { enabled: true });
    assert.deepEqual(editor.extensions.mermaid, { enabled: true, config: { asset: {
      url: '/installation/vendor/host/mermaid.min.js?v=test-version', version: '12.2.0',
    } } });
    window.CODIWARE_BOOT.extensions['codiware.markdown']['MARKIAN.CODE'] = false;
    window.CODIWARE_BOOT.extensions['codiware.markdown']['MARKIAN.MERMAID'] = false;
    const disabled = markdownEditorDescriptor.create(host, { api: { base: '/installation/api/ide/codiware' } });
    await disabled._initPromise;
    assert.equal(disabled.extensions.code, undefined);
    assert.equal(disabled.extensions.mermaid, undefined);
    assert.equal(links.length, 5);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});

test('Markdown adapter keeps the tab host intact and forwards sidebar visibility', async () => {
  const previous = { Markian: globalThis.Markian, document: globalThis.document, MutationObserver: globalThis.MutationObserver };
  const options = [];
  let tabHost;
  globalThis.document = { documentElement: { dataset: { theme: 'light' } }, createElement: () => ({}) };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.Markian = { create(host, settings) {
    assert.notEqual(host, tabHost);
    assert.equal(tabHost.children[0], host);
    const element = { classList: { add() {} } };
    tabHost.children.splice(0, 1, element);
    options.push(settings);
    return { element, ready: Promise.resolve(), on() {}, get: () => '# Document' };
  } };
  try {
    for (const settings of [{}, { 'MARKIAN.SIDEBAR_VISIBLE': false }]) {
      tabHost = { children: [], style: { display: 'none' }, replaceChildren(...children) { this.children = children; } };
      const adapter = Object.assign(Object.create(MarkdownEditor.prototype), {
        _initPromise: Promise.resolve(), _generation: 0, _destroyed: false,
        settings, host: tabHost, ctx: {}, listeners: { change: [], 'save-request': [] },
      });
      await adapter.load('# Document', { path: 'Guide.md' });
      assert.equal(adapter.host, tabHost);
      assert.equal(tabHost.children[0], adapter.editorEl);
      assert.equal(tabHost.style.display, 'none');
    }
    assert.deepEqual(options.map(settings => settings.sidebarVisible), [true, false]);
  } finally {
    Object.assign(globalThis, previous);
  }
});

test('host content classes apply to document surfaces, never the editor shell', () => {
  const classes = new Set();
  const adapter = Object.create(MarkdownEditor.prototype);
  adapter.settings = { CSS_CLASS_FOR_PREVIEW_CONTAINER: 'markdown-body host-docs' };
  adapter.editorEl = { querySelectorAll: selector => {
    assert.equal(selector, '.markian-document');
    return [{ classList: { add: (...values) => values.forEach(value => classes.add(value)) } }];
  } };
  adapter._applyMarkdownClasses();
  assert.deepEqual([...classes], ['markdown-body', 'host-docs']);
});

test('Markdown adapter preserves load baselines, pending saves, and idempotent disposal', async () => {
  const adapter = Object.create(MarkdownEditor.prototype);
  let content = '';
  let changes = 0;
  let destroyed = 0;
  let disconnected = 0;
  let cleared = 0;
  let idleReached = false;
  Object.assign(adapter, {
    _initPromise: Promise.resolve(), _generation: 0, _destroyed: false,
    settings: {}, listeners: { change: [() => changes++], 'save-request': [] },
    host: { replaceChildren() { cleared++; } },
    _themeObserver: { disconnect() { disconnected++; } },
    _previewObserver: { disconnect() { disconnected++; } },
    editor: {
      ready: Promise.resolve(),
      set(value, options) {
        assert.equal(adapter._loading, true);
        assert.deepEqual(options, { origin: 'host-load', resetHistory: true, pending: 'discard' });
        content = value.trim();
      },
      get: () => content,
      async whenIdle() { idleReached = true; },
      destroy() { destroyed++; },
    },
  });
  await adapter.load('# Loaded\n', { path: 'Docs/Guide.md' });
  assert.equal(adapter._currentDir, 'Docs');
  assert.equal(adapter.getContent(), '# Loaded');
  assert.equal(adapter.isDirty(), false);
  assert.equal(changes, 1);
  const snapshot = { content: adapter.getContent() };
  content = '# Later edit';
  await adapter.beforeSave();
  assert.equal(idleReached, true);
  adapter.markClean(snapshot);
  assert.equal(adapter.isDirty(), true);
  content = snapshot.content;
  assert.equal(adapter.isDirty(), false);
  adapter.destroy();
  adapter.destroy();
  assert.equal(destroyed, 1);
  assert.equal(disconnected, 2);
  assert.equal(cleared, 1);
  assert.equal(adapter.editor, null);
  assert.deepEqual(adapter.listeners, { change: [], 'save-request': [] });
});