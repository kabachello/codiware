import { Icon } from './Icon.js';

/**
 * Create a shared popup-menu controller with nested submenu support.
 *
 * The controller is intentionally DOM-only and has no dependencies on panels
 * such as Git, history, file tree or tabs. It accepts menu item descriptors:
 * `{ icon, label, onClick, disabled, children }`, section headings
 * `{ heading: true, label }` plus separator items `{ sep: true }`.
 *
 * Touch handling is explicit: hover opens submenus only for real mouse
 * pointers, while tapping a submenu parent only opens its child menu and never
 * activates the first child accidentally. Outside taps/clicks are captured via
 * pointer events so menus also close reliably on mobile browsers that do not
 * dispatch desktop `mousedown` events for touch input.
 */
export function createPopupMenuController() {
  return {
    stack: [],
    outsidePointerHandler: null,
    outsideMouseHandler: null,
    contextMenuHandler: null,
    keyHandler: null,
    resizeHandler: null,
    scrollHandler: null,

    /** Open a top-level menu below an anchor element. */
    open(anchor, items) {
      const rect = anchor.getBoundingClientRect();
      this.openAt(rect.right, rect.bottom + 2, items, { flipYFrom: rect.top - 2, anchorRect: rect });
    },

    /** Open a top-level menu at viewport coordinates. */
    openAt(x, y, items, options = {}) {
      this.closeAll();
      this._ensureGlobalListeners();
      this._openLevel({ x, y, items, level: 0, parentButton: null, options });
    },

    /** Close every visible menu level and remove global event listeners. */
    closeAll() {
      while (this.stack.length) {
        const entry = this.stack.pop();
        entry.menu.remove();
      }
      this._removeGlobalListeners();
    },

    /** Close menu levels starting after the given zero-based depth. */
    closeFrom(level) {
      while (this.stack.length > level) {
        const entry = this.stack.pop();
        entry.menu.remove();
      }
      if (this.stack.length === 0) this._removeGlobalListeners();
    },

    /** Render and position one menu level, replacing older levels at that depth. */
    _openLevel({ x, y, items, level, parentButton, options = {} }) {
      this.closeFrom(level);
      const menu = this._renderMenu(items, level);
      document.body.appendChild(menu);
      const pos = this._positionMenu(menu, x, y, options);
      menu.style.left = pos.left + 'px';
      menu.style.top = pos.top + 'px';
      this.stack.push({ menu, level, parentButton });
    },

    /** Convert item descriptors into a keyboard- and pointer-friendly menu DOM. */
    _renderMenu(items, level) {
      const menu = document.createElement('div');
      menu.className = 'codiware-popup-menu';
      menu.setAttribute('role', 'menu');
      menu.dataset.menuLevel = String(level);
      menu.addEventListener('pointerleave', (event) => {
        if (event.pointerType && event.pointerType !== 'mouse') return;
        this._scheduleHoverSync();
      });

      for (const item of items || []) {
        if (item.sep) {
          const sep = document.createElement('div');
          sep.className = 'menu-sep';
          menu.appendChild(sep);
          continue;
        }
        if (item.heading) {
          const heading = document.createElement('div');
          heading.className = 'menu-heading';
          heading.setAttribute('role', 'presentation');
          heading.textContent = item.label || '';
          menu.appendChild(heading);
          continue;
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'menu-item';
        if (item.disabled) btn.classList.add('is-disabled');
        btn.disabled = Boolean(item.disabled);
        btn.setAttribute('role', 'menuitem');
        btn.append(Icon.render(item.icon || ''));
        const label = document.createElement('span');
        label.textContent = item.label || '';
        btn.appendChild(label);
        if (Array.isArray(item.children) && item.children.length > 0) {
          btn.classList.add('has-children');
          btn.appendChild(Icon.render('fa fa-caret-right'));
          btn.addEventListener('pointerenter', (event) => {
            if (item.disabled || (event.pointerType && event.pointerType !== 'mouse')) return;
            this._openChildMenu(btn, item.children, level);
          });
          btn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (item.disabled) return;
            this._openChildMenu(btn, item.children, level);
          });
        } else {
          btn.addEventListener('pointerenter', (event) => {
            if (event.pointerType && event.pointerType !== 'mouse') return;
            this.closeFrom(level + 1);
          });
          btn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (item.disabled) return;
            this.closeAll();
            try { item.onClick?.(); } catch (err) { console.error(err); }
          });
        }
        menu.appendChild(btn);
      }
      return menu;
    },

    /** Open a submenu next to the parent item, flipping left on narrow screens. */
    _openChildMenu(button, items, parentLevel) {
      const rect = button.getBoundingClientRect();
      this._openLevel({
        x: rect.right + 2,
        y: rect.top,
        items,
        level: parentLevel + 1,
        parentButton: button,
        options: { flipYFrom: rect.bottom, parentRect: rect },
      });
    },

    /** Keep a menu inside the viewport and avoid overlapping submenu parents. */
    _positionMenu(menu, x, y, options) {
      const mw = menu.offsetWidth;
      const mh = menu.offsetHeight;
      let left = x;
      const parentRect = options.parentRect || null;
      if (parentRect && x + mw > window.innerWidth - 4) {
        const leftOfParent = parentRect.left - mw - 2;
        left = leftOfParent >= 4 ? leftOfParent : Math.min(x, window.innerWidth - mw - 4);
      } else left = Math.min(x, window.innerWidth - mw - 4);
      if (left < 4) left = 4;
      let top = y;
      if (top + mh > window.innerHeight - 4) {
        const flipYFrom = typeof options.flipYFrom === 'number' ? options.flipYFrom : (y - 4);
        top = Math.max(4, flipYFrom - mh);
      }
      return { left, top };
    },

    /** Install global close handlers once per open menu tree. */
    _ensureGlobalListeners() {
      if (!this.outsidePointerHandler) {
        this.outsidePointerHandler = (event) => { if (!this._containsNode(event.target)) this.closeAll(); };
        document.addEventListener('pointerdown', this.outsidePointerHandler, true);
      }
      if (!this.outsideMouseHandler) {
        this.outsideMouseHandler = (event) => { if (!this._containsNode(event.target)) this.closeAll(); };
        document.addEventListener('mousedown', this.outsideMouseHandler, true);
      }
      if (!this.contextMenuHandler) {
        this.contextMenuHandler = (event) => { if (!this._containsNode(event.target)) this.closeAll(); };
        document.addEventListener('contextmenu', this.contextMenuHandler, true);
      }
      if (!this.keyHandler) {
        this.keyHandler = (event) => { if (event.key === 'Escape') this.closeAll(); };
        document.addEventListener('keydown', this.keyHandler, true);
      }
      if (!this.resizeHandler) {
        this.resizeHandler = () => this.closeAll();
        window.addEventListener('resize', this.resizeHandler);
      }
      if (!this.scrollHandler) {
        this.scrollHandler = () => this.closeAll();
        window.addEventListener('scroll', this.scrollHandler, true);
      }
    },

    /** Remove global handlers when the last menu level closes. */
    _removeGlobalListeners() {
      if (this.outsidePointerHandler) { document.removeEventListener('pointerdown', this.outsidePointerHandler, true); this.outsidePointerHandler = null; }
      if (this.outsideMouseHandler) { document.removeEventListener('mousedown', this.outsideMouseHandler, true); this.outsideMouseHandler = null; }
      if (this.contextMenuHandler) { document.removeEventListener('contextmenu', this.contextMenuHandler, true); this.contextMenuHandler = null; }
      if (this.keyHandler) { document.removeEventListener('keydown', this.keyHandler, true); this.keyHandler = null; }
      if (this.resizeHandler) { window.removeEventListener('resize', this.resizeHandler); this.resizeHandler = null; }
      if (this.scrollHandler) { window.removeEventListener('scroll', this.scrollHandler, true); this.scrollHandler = null; }
    },

    /** Return true when a node belongs to any visible menu level or parent item. */
    _containsNode(node) {
      return this.stack.some((entry) => entry.menu.contains(node) || entry.parentButton?.contains?.(node));
    },

    /** Defer hover synchronization until the browser has updated `:hover`. */
    _scheduleHoverSync() { requestAnimationFrame(() => this._syncMenusToHover()); },

    /** Close detached hover submenus after the mouse leaves the active path. */
    _syncMenusToHover() {
      const hovered = Array.from(document.querySelectorAll(':hover'));
      if (this.stack.length <= 1) {
        const root = this.stack[0];
        if (!root) return;
        if (!hovered.some((el) => root.menu.contains(el))) this.closeAll();
        return;
      }
      let keepDepth = 1;
      for (let i = 1; i < this.stack.length; i++) {
        const entry = this.stack[i];
        const overParent = entry.parentButton ? hovered.includes(entry.parentButton) : false;
        const overMenu = hovered.some((el) => entry.menu.contains(el));
        if (overParent || overMenu) keepDepth = i + 1;
        else break;
      }
      const root = this.stack[0];
      const overRoot = root ? hovered.some((el) => root.menu.contains(el)) : false;
      if (!overRoot && keepDepth <= 1) this.closeAll();
      else this.closeFrom(keepDepth);
    },
  };
}

/** Single application-wide popup menu instance. */
export const PopupMenu = createPopupMenuController();

/**
 * Install a small compatibility safety net for legacy menu code that may still
 * create `.codiware-popup-menu` DOM nodes while it is being migrated. It only
 * removes orphan menu layers on outside touch/pointer input and suppresses
 * touch/pen hover-open events for submenu parents; the shared controller above
 * remains the owner for all new menu behaviour and cleanup.
 */
function installLegacyPopupCompatibility() {
  if (typeof document === 'undefined' || window.__codiwarePopupCompatibilityInstalled) return;
  window.__codiwarePopupCompatibilityInstalled = true;
  document.addEventListener('pointerenter', (event) => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    const item = event.target?.closest?.('.codiware-popup-menu .menu-item.has-children');
    if (item) event.stopImmediatePropagation();
  }, true);
  document.addEventListener('pointerdown', (event) => {
    const menus = Array.from(document.querySelectorAll('.codiware-popup-menu'));
    if (!menus.length || menus.some((menu) => menu.contains(event.target))) return;
    menus.forEach((menu) => menu.remove());
  }, true);
}

if (typeof window !== 'undefined') {
  window.CodiwarePopupMenu = PopupMenu;
  installLegacyPopupCompatibility();
}
