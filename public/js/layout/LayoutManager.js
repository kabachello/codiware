import { attachSplitter } from './Splitter.js';
import { Icon } from '../core/Icon.js';

/**
 * Builds the three-row IDE chrome: titlebar / body (sidebar + main) / statusbar.
 * Exposes named slots for the rest of the app to mount into.
 */
export class LayoutManager {
  constructor(rootEl, { i18n, state, bus, settings } = {}) {
    this.root = rootEl;
    this.i18n = i18n;
    this.state = state;
    this.bus = bus;
    this.settings = settings || null;
    this.slots = {};
    this.sidebarWidth = this._restoreSize('layout.sidebarWidth', 260, 160, this._maxSidebarWidth());
    this.sidebarCollapsed = false;
    this.sidebarStripWidth = 44;
    this.bottomHeight = this._restoreSize('layout.bottomHeight', 220, 72, 2000);
    this.bottomCollapsed = true;
    this.bottomStripHeight = 32;
  }

  /**
   * Read a globally persisted layout size, clamped to a sane range.
   *
   * @param {string} name     Setting name in the global SettingsStore.
   * @param {number} fallback Default when nothing valid is stored.
   * @param {number} min      Lower bound.
   * @param {number} max      Upper bound.
   * @returns {number}
   */
  _restoreSize(name, fallback, min, max) {
    const saved = this.settings?.getGlobal(name);
    if (typeof saved !== 'number' || !Number.isFinite(saved)) return fallback;
    return Math.max(min, Math.min(max, saved));
  }

  _maxSidebarWidth() {
    return Math.max(160, Math.round((window.innerWidth || 1024) * 0.7));
  }

  build() {
    this.root.innerHTML = '';
    this.root.removeAttribute('aria-busy');

    // Titlebar
    const title = el('header', 'ide-titlebar');
    title.appendChild(el('span', 'ide-title', 'Codiware'));
    const ws = el('span', 'ide-workspace');
    title.appendChild(ws);
    this.slots.workspaceLabel = ws;
    const right = el('span', '', '');
    right.style.marginLeft = 'auto';
    title.appendChild(right);
    this.slots.titleRight = right;

    // Body
    const body = el('div', 'ide-body');
    body.style.gridTemplateColumns = this.sidebarWidth + 'px 5px 1fr';
    this.slots.body = body;
    const sidebar = el('aside', 'ide-sidebar');
    const tabs = el('div', 'ide-sidebar-tabs');
    const content = el('div', 'ide-sidebar-content');
    sidebar.append(tabs, content);
    this.slots.sidebarTabs = tabs;
    this.slots.sidebarContent = content;

    const splitterX = el('div', 'ide-splitter');
    this.slots.sidebarSplitter = splitterX;
    const main = el('section', 'ide-main');
    const editorArea = el('div', 'ide-editor-area');
    const tabBar = el('div', 'ide-tabs');
    const editorHost = el('div', 'ide-editor-host');
    editorArea.append(tabBar, editorHost);
    this.slots.editorTabs = tabBar;
    this.slots.editorHost = editorHost;

    const splitterY = el('div', 'ide-splitter');
    splitterY.style.cursor = 'row-resize';
    const bottom = el('div', 'ide-bottom');
    const bottomTabs = el('div', 'ide-bottom-tabs');
    const bottomContent = el('div', 'ide-bottom-content');
    bottom.append(bottomTabs, bottomContent);
    this.slots.bottomPanel = bottom;
    this.slots.bottomTabs = bottomTabs;
    this.slots.bottomContent = bottomContent;
    this.slots.bottomSplitter = splitterY;

    main.append(editorArea, splitterY, bottom);
    body.append(sidebar, splitterX, main);

    // Statusbar
    const status = el('footer', 'ide-statusbar');
    this.slots.statusLeft = el('span');
    this.slots.statusRight = el('span');
    this.slots.statusRight.style.marginLeft = 'auto';
    status.append(this.slots.statusLeft, this.slots.statusRight);

    this.root.append(title, body, status);

    // Default layout state
    this.collapseBottom();

    // Sidebar resize
    attachSplitter(splitterX, {
      orientation: 'vertical',
      onResize: {
        getSize: () => this.sidebarWidth,
        apply: (px) => {
          this.sidebarWidth = Math.max(160, Math.min(this._maxSidebarWidth(), px));
          this._applySidebarState();
          this.settings?.setGlobal('layout.sidebarWidth', this.sidebarWidth);
        }
      }
    });

    // Bottom panel resize (drag upward grows the bottom)
    attachSplitter(splitterY, {
      orientation: 'horizontal',
      onResize: {
        invert: true,
        getSize: () => this.bottomHeight,
        apply: (px) => {
          this.expandBottom(Math.max(this.bottomStripHeight + 40, Math.min(window.innerHeight - 200, px)));
          this.settings?.setGlobal('layout.bottomHeight', this.bottomHeight);
        }
      }
    });
  }

  setWorkspaceLabel(text) {
    this.slots.workspaceLabel.textContent = text;
  }

  setStatusLeft(text, icon) {
    this.slots.statusLeft.innerHTML = '';
    if (icon) this.slots.statusLeft.append(Icon.render(icon));
    const t = document.createElement('span');
    t.textContent = ' ' + (text || '');
    this.slots.statusLeft.append(t);
  }
  setStatusRight(text) { this.slots.statusRight.textContent = text; }

  setSidebarWidth(px) {
    if (px <= this.sidebarStripWidth) {
      this.collapseSidebar();
      return;
    }
    this.expandSidebar(px);
  }

  toggleSidebar(defaultWidth) {
    if (this.sidebarCollapsed) this.expandSidebar(defaultWidth);
    else this.collapseSidebar();
  }

  isSidebarCollapsed() {
    return this.sidebarCollapsed;
  }

  collapseSidebar() {
    this.sidebarCollapsed = true;
    this._applySidebarState();
  }

  expandSidebar(px) {
    this.sidebarCollapsed = false;
    this.sidebarWidth = Math.max(160, Math.min(this._maxSidebarWidth(), px || this.sidebarWidth || 260));
    this._applySidebarState();
  }

  setBottomHeight(px) {
    if (px <= this.bottomStripHeight) {
      this.collapseBottom();
      return;
    }
    this.expandBottom(px);
  }

  toggleBottom(defaultHeight) {
    if (this.bottomCollapsed) this.expandBottom(defaultHeight);
    else this.collapseBottom();
  }

  isBottomCollapsed() {
    return this.bottomCollapsed;
  }

  collapseBottom() {
    this.bottomCollapsed = true;
    this._applyBottomState();
  }

  expandBottom(px) {
    this.bottomCollapsed = false;
    this.bottomHeight = Math.max(this.bottomStripHeight + 40, px || this.bottomHeight || 220);
    this._applyBottomState();
  }

  /**
   * Apply a collapsible right-hand editor side panel state to one editor shell.
   *
   * The caller provides the editor-local shell elements so this generic layout
   * manager can reuse the same collapse/expand behavior for Monaco's outline or
   * future editor-specific side panels without coupling to editor code.
   *
   * @param {object} options
   * @param {HTMLElement} options.shell             Grid container that owns main area, splitter and side panel.
   * @param {HTMLElement} options.panel             The collapsible side panel element.
   * @param {HTMLElement} [options.splitter]        Splitter between main area and panel.
   * @param {number} options.panelWidth             Expanded panel width in pixels.
   * @param {number} options.stripWidth             Collapsed strip width in pixels.
   * @param {boolean} options.collapsed             Whether the panel is currently collapsed.
   */
  applyEditorSidePanelState({ shell, panel, splitter, panelWidth, stripWidth, collapsed }) {
    if (!shell || !panel) return;

    const safeStripWidth = Math.max(36, Number(stripWidth) || 44);
    const safePanelWidth = Math.max(120, Number(panelWidth) || 180);

    if (collapsed) {
      shell.style.gridTemplateColumns = `minmax(0, 1fr) ${safeStripWidth}px`;
      if (splitter) splitter.style.display = 'none';
      panel.classList.add('is-collapsed');
      return;
    }

    shell.style.gridTemplateColumns = `minmax(0, 1fr) 5px ${safePanelWidth}px`;
    if (splitter) splitter.style.display = '';
    panel.classList.remove('is-collapsed');
  }

  _applyBottomState() {
    const main = this.root.querySelector('.ide-main');
    const splitter = this.slots.bottomSplitter;
    const bottom = this.slots.bottomPanel;

    if (this.bottomCollapsed) {
      main.classList.remove('has-bottom');
      // When collapsed, the splitter is hidden, so use a two-row grid to avoid
      // the bottom panel being placed into the (0px) splitter row by auto-flow.
      main.style.gridTemplateRows = `1fr ${this.bottomStripHeight}px`;
      splitter.style.display = 'none';
      bottom.classList.add('is-collapsed');
      return;
    }

    main.classList.add('has-bottom');
    main.style.gridTemplateRows = `1fr 5px ${this.bottomHeight}px`;
    splitter.style.display = '';
    bottom.classList.remove('is-collapsed');
  }

  _applySidebarState() {
    const body = this.slots.body;
    const sidebar = this.root.querySelector('.ide-sidebar');
    const splitter = this.slots.sidebarSplitter;

    if (!body || !sidebar || !splitter) return;

    if (this.sidebarCollapsed) {
      // When collapsed, the splitter is hidden, so use a two-column grid to
      // avoid the main area (and its bottom panel) being auto-placed into the
      // now-empty splitter track by grid auto-flow.
      body.style.gridTemplateColumns = `${this.sidebarStripWidth}px 1fr`;
      splitter.style.display = 'none';
      sidebar.classList.add('is-collapsed');
      return;
    }

    body.style.gridTemplateColumns = `${this.sidebarWidth}px 5px 1fr`;
    splitter.style.display = '';
    sidebar.classList.remove('is-collapsed');
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
