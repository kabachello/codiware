import { Icon } from '../core/Icon.js';

/**
 * Sidebar panel manager: registers named panels (files/git/search) and switches between them.
 */
export class PanelManager {
  constructor({ tabsEl, contentEl, i18n }) {
    this.tabsEl = tabsEl;
    this.contentEl = contentEl;
    this.i18n = i18n;
    this.panels = new Map();
    this.active = null;
  }

  register(id, { label, icon, mount, onActivate }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.panel = id;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.append(Icon.render(icon));
    btn.addEventListener('click', () => this.activate(id));
    this.tabsEl.appendChild(btn);

    const host = document.createElement('div');
    host.style.display = 'none';
    host.style.height = '100%';
    host.className = 'ide-sidebar-panel-host';

    const panelRoot = document.createElement('div');
    panelRoot.className = 'ide-sidebar-panel-root';

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
      busyCount: 0,
    });
    if (this.active === null) this.activate(id);
  }

  activate(id) {
    const panel = this.panels.get(id);
    if (!panel) return;
    for (const p of this.panels.values()) {
      p.btn.classList.toggle('active', p.id === id);
      p.host.style.display = p.id === id ? '' : 'none';
    }
    const firstActivation = !panel.mounted;
    if (firstActivation) {
      try { panel.mount(panel.panelRoot); panel.mounted = true; }
      catch (e) { console.error('[PanelManager] mount', id, e); }
    }
    this.active = id;
    if (typeof panel.onActivate === 'function') {
      try { panel.onActivate({ firstActivation }); }
      catch (e) { console.error('[PanelManager] onActivate', id, e); }
    }
  }

  setBusy(id, busy, message) {
    const panel = this.panels.get(id);
    if (!panel) return;
    if (busy) panel.busyCount += 1;
    else panel.busyCount = Math.max(0, panel.busyCount - 1);
    const isBusy = panel.busyCount > 0;

    panel.btn.classList.toggle('is-busy', isBusy);
  }
}
