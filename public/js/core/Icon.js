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
  worktree: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3,3H9V7H3V3M15,10H21V14H15V10M15,17H21V21H15V17M13,13H7V18H13V20H7L5,20V9H7V11H13V13Z" /></svg>',
  switchWorktree: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M20 18H4V8H20M20 6H12L10 4H4A2 2 0 0 0 2 6V18A2 2 0 0 0 4 20H20A2 2 0 0 0 22 18V8A2 2 0 0 0 20 6M14 9H16V13H19L15 17L11 13H14Z" /></svg>',
  checkoutBranch: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5,20H19V18H5M19,9H15V3H9V9H5L12,16L19,9Z" /></svg>',

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
