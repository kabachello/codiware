/**
 * Icon helper supporting two notations everywhere icons are accepted:
 *
 *   1. FontAwesome 4 class string: `"fa fa-folder"` or shorthand `"fa-folder"`.
 *   2. Inline SVG (e.g. Pictogrammers MDI): a string that starts with `<svg`.
 *
 * Use `Icon.render(spec)` to obtain an `HTMLElement` ready to append.
 * Use `Icon.html(spec)` to obtain an HTML string (useful inside templates).
 *
 * MDI usage example:
 *   import { mdiFolder } from '../icons/mdi.js';
 *   button.append(Icon.render(mdiFolder));
 *
 * Passing `null`/empty returns an empty placeholder span (kept so layouts
 * remain stable when an icon is intentionally absent).
 */
export const Icon = {
  /**
   * @param {string|null|undefined} spec
   * @param {{title?:string, extraClass?:string}} [opts]
   * @returns {HTMLElement}
   */
  render(spec, opts = {}) {
    const el = document.createElement('span');
    el.className = 'ide-icon';
    if (opts.extraClass) el.className += ' ' + opts.extraClass;
    if (opts.title) el.title = opts.title;
    if (!spec) return el;
    const s = String(spec).trim();
    if (s.startsWith('<svg')) {
      el.innerHTML = s;
      const svg = el.firstElementChild;
      if (svg && !svg.hasAttribute('aria-hidden')) svg.setAttribute('aria-hidden', 'true');
      return el;
    }
    // FontAwesome 4: accept "fa fa-x", "fa-x", or "x".
    let cls = s;
    if (!cls.includes('fa-')) cls = 'fa-' + cls;
    if (!/(^|\s)fa(\s|$)/.test(cls)) cls = 'fa ' + cls;
    const i = document.createElement('i');
    i.className = cls;
    i.setAttribute('aria-hidden', 'true');
    el.appendChild(i);
    return el;
  },

  /**
   * @param {string|null|undefined} spec
   * @returns {string} HTML string for use in templates.
   */
  html(spec) {
    return this.render(spec).outerHTML;
  },
};
