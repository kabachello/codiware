import { attachSplitter } from './Splitter.js';
import { Icon } from '../core/Icon.js';

/**
 * Builds the three-row IDE chrome: titlebar / body (sidebar + main) / statusbar.
 * Exposes named slots for the rest of the app to mount into.
 */
export class LayoutManager {
  constructor(rootEl, { i18n, state, bus }) {
    this.root = rootEl;
    this.i18n = i18n;
    this.state = state;
    this.bus = bus;
    this.slots = {};
    this.sidebarWidth = 260;
    this.bottomHeight = 220;
    this.bottomCollapsed = true;
    this.bottomStripHeight = 32;
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
    const sidebar = el('aside', 'ide-sidebar');
    const tabs = el('div', 'ide-sidebar-tabs');
    const content = el('div', 'ide-sidebar-content');
    sidebar.append(tabs, content);
    this.slots.sidebarTabs = tabs;
    this.slots.sidebarContent = content;

    const splitterX = el('div', 'ide-splitter');
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
          this.sidebarWidth = Math.max(160, Math.min(600, px));
          body.style.gridTemplateColumns = this.sidebarWidth + 'px 5px 1fr';
        }
      }
    });

    // Bottom panel resize (drag upward grows the bottom)
    attachSplitter(splitterY, {
      orientation: 'horizontal',
      onResize: {
        invert: true,
        getSize: () => this.bottomHeight,
        apply: (px) => this.expandBottom(Math.max(this.bottomStripHeight + 40, Math.min(window.innerHeight - 200, px)))
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

  setBottomHeight(px) {
    if (px <= this.bottomStripHeight) {
      this.collapseBottom();
      return;
    }
    this.expandBottom(px);
  }

  toggleBottom(defaultHeight = 220) {
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

  expandBottom(px = 220) {
    this.bottomCollapsed = false;
    this.bottomHeight = Math.max(this.bottomStripHeight + 40, px || this.bottomHeight || 220);
    this._applyBottomState();
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
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
