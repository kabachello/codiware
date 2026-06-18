/**
 * Single shared Monaco AMD loader.
 *
 * Monaco ships as an AMD bundle whose `loader.js` declares a global
 * `_amdLoaderGlobal` and installs `window.require` / `window.define`. Injecting
 * that script more than once throws `Identifier '_amdLoaderGlobal' has already
 * been declared`, so every editor that needs Monaco (code editor, diff editor)
 * must funnel through this one loader.
 *
 * The promise is cached on `window` rather than in module scope so that even if
 * this module is evaluated more than once (e.g. via different import graphs),
 * `loader.js` is still only ever injected a single time.
 *
 * Monaco keeps using its AMD `require`/`define` globals after `editor.main`
 * loads (languages, workers and other features are loaded lazily through them),
 * so they are intentionally left in place. Any pre-existing globals are restored
 * so unrelated AMD setups keep working. Code that must not be captured by
 * Monaco's `define.amd` (notably xterm.js) handles that on its own side.
 */
export function loadMonaco() {
  if (window.monaco) return Promise.resolve(window.monaco);
  if (window.__codiwareMonacoPromise) return window.__codiwareMonacoPromise;

  window.__codiwareMonacoPromise = new Promise((resolve, reject) => {
    const base = window.CODIWARE_BOOT?.extensions?.['codiware.markdown']?.['INCLUDES.MONACO_JS_BASE']
      || (window.CODIWARE_ASSET_BASE_APP || '') + '/monaco/node_modules/monaco-editor/min/vs';

    const hadRequire = 'require' in window;
    const hadDefine = 'define' in window;
    const previousRequire = window.require;
    const previousDefine = window.define;

    // Only restore globals that existed before Monaco. If none existed, leave
    // Monaco's loader in place — deleting it breaks Monaco's lazy module loading
    // ("define is not a function" in editor.main.js).
    const restoreGlobals = () => {
      if (hadDefine) window.define = previousDefine;
      if (hadRequire) window.require = previousRequire;
    };

    const loader = document.createElement('script');
    loader.src = base + '/loader.js';
    loader.async = true;
    loader.onload = () => {
      try {
        window.require.config({ paths: { vs: base } });
        // Workers need an absolute URL prefix to satisfy same-origin rules.
        window.MonacoEnvironment = window.MonacoEnvironment || {
          getWorkerUrl: function (_moduleId, _label) {
            return URL.createObjectURL(new Blob([
              `self.MonacoEnvironment = { baseUrl: '${base}/' };`,
              `importScripts('${base}/base/worker/workerMain.js');`,
            ], { type: 'text/javascript' }));
          },
        };
        window.require(['vs/editor/editor.main'], () => {
          const monaco = window.monaco;
          restoreGlobals();
          resolve(monaco);
        }, (err) => { restoreGlobals(); reject(err); });
      } catch (e) {
        restoreGlobals();
        reject(e);
      }
    };
    loader.onerror = () => reject(new Error('Failed to load Monaco loader from ' + loader.src));
    document.head.appendChild(loader);
  });
  return window.__codiwareMonacoPromise;
}
