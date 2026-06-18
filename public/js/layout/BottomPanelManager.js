import { Icon } from '../core/Icon.js';

/**
 * Bottom panel manager: registers tabbed panels and coordinates expansion.
 */
export class BottomPanelManager {
  constructor({ tabsEl, contentEl, layout }) {
    this.tabsEl = tabsEl;
    this.contentEl = contentEl;
    this.layout = layout;
    this.panels = new Map();
    this.active = null;

    // Collapsed bottom stripe should still be clickable even outside the pills.
    this.tabsEl.addEventListener('click', (event) => {
      if (!this.layout.isBottomCollapsed()) return;
      if (event.target instanceof HTMLButtonElement) return;
      if (this.active) this.layout.expandBottom();
    });
  }

  register(id, { label, icon, mount, onActivate }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.panel = id;
    if (icon) btn.append(Icon.render(icon), document.createTextNode(' '));
    btn.append(document.createTextNode(label));
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.addEventListener('click', () => this.activate(id, { expand: true }));
    const collapseBtn = this.tabsEl.querySelector('.ide-bottom-collapse');
    if (collapseBtn) this.tabsEl.insertBefore(btn, collapseBtn);
    else this.tabsEl.appendChild(btn);

    const host = document.createElement('div');
    host.style.display = 'none';
    host.className = 'ide-bottom-panel-host';

    const panelRoot = document.createElement('div');
    panelRoot.className = 'ide-bottom-panel-root';
    host.append(panelRoot);
    this.contentEl.appendChild(host);

    this.panels.set(id, {
      id,
      label,
      btn,
      host,
      panelRoot,
      mount,
      onActivate,
      mounted: false,
    });

    if (this.active === null) {
      this.activate(id, { expand: false });
    }
  }

  has(id) {
    return this.panels.has(id);
  }

  activate(id, { expand = true, height } = {}) {
    const panel = this.panels.get(id);
    if (!panel) return;

    for (const p of this.panels.values()) {
      p.btn.classList.toggle('active', p.id === id);
      p.host.style.display = p.id === id ? '' : 'none';
    }

    const firstActivation = !panel.mounted;
    if (firstActivation) {
      try { panel.mount(panel.panelRoot); panel.mounted = true; }
      catch (e) { console.error('[BottomPanelManager] mount', id, e); }
    }

    this.active = id;
    if (expand) this.layout.expandBottom(height);

    if (typeof panel.onActivate === 'function') {
      try { panel.onActivate({ firstActivation }); }
      catch (e) { console.error('[BottomPanelManager] onActivate', id, e); }
    }
  }

  toggle(id, defaultHeight) {
    if (!this.panels.has(id)) return;
    if (this.active === id && !this.layout.isBottomCollapsed()) {
      this.layout.collapseBottom();
      return;
    }
    this.activate(id, { expand: true, height: defaultHeight });
  }
}