import { Icon } from '../core/Icon.js';

/**
 * Default icon mapping used when no `fileIcons` config is passed in. The
 * config from PHP (`boot.file_icons`) is merged on top of this so missing
 * keys fall back to sensible defaults.
 */
const DEFAULT_FILE_ICONS = {
  default: 'fa fa-file-o',
  folder: 'fa fa-folder',
  folder_open: 'fa fa-folder-open',
  by_name: {},
  by_ext: {},
};

/**
 * Recursive file tree using nested <ul> elements.
 * Each directory is loaded lazily through `api.get('/files/tree', {path})`.
 */
export class FileTree {
  constructor({ host, api, i18n, onOpen, fileIcons }) {
    this.host = host;
    this.api = api;
    this.i18n = i18n;
    this.onOpen = onOpen;
    this.fileIcons = {
      ...DEFAULT_FILE_ICONS,
      ...(fileIcons || {}),
      by_name: { ...DEFAULT_FILE_ICONS.by_name, ...((fileIcons && fileIcons.by_name) || {}) },
      by_ext: { ...DEFAULT_FILE_ICONS.by_ext, ...((fileIcons && fileIcons.by_ext) || {}) },
    };
    this.rootUl = document.createElement('ul');
    this.rootUl.className = 'tree';
    this.host.innerHTML = '';
    this.host.appendChild(this.rootUl);
  }

  async refresh() {
    this.rootUl.innerHTML = '';
    await this._renderInto(this.rootUl, '');
  }

  async _renderInto(ul, path) {
    let data;
    try { data = await this.api.get('/files/tree', { path }); }
    catch (e) {
      const li = document.createElement('li');
      li.textContent = e.message;
      li.style.color = '#c0392b';
      ul.appendChild(li);
      return;
    }
    const entries = data?.entries || [];
    if (entries.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = this.i18n.t('files.empty');
      li.style.opacity = '0.6';
      ul.appendChild(li);
      return;
    }
    for (const entry of entries) {
      ul.appendChild(this._renderEntry(entry));
    }
  }

  _renderEntry(entry) {
    const li = document.createElement('li');
    li.className = entry.type === 'dir' ? 'dir' : 'file';
    li.dataset.path = entry.path;

    const row = document.createElement('span');
    row.className = 'row';

    if (entry.type === 'dir') {
      const toggle = Icon.render('fa fa-caret-right', { extraClass: 'ide-icon-toggle' });
      const folderIconSpec = this.fileIcons.folder || 'fa fa-folder';
      const folderOpenSpec = this.fileIcons.folder_open || folderIconSpec;
      let folder = Icon.render(folderIconSpec);
      const name = document.createElement('span');
      name.textContent = entry.name;
      row.append(toggle, folder, name);
      row.addEventListener('click', async () => {
        const open = li.classList.toggle('open');
        toggle.firstElementChild?.classList.toggle('fa-caret-right', !open);
        toggle.firstElementChild?.classList.toggle('fa-caret-down', open);
        const replacement = Icon.render(open ? folderOpenSpec : folderIconSpec);
        folder.replaceWith(replacement);
        folder = replacement;
        let childUl = li.querySelector(':scope > ul');
        if (open) {
          if (!childUl) {
            childUl = document.createElement('ul');
            li.appendChild(childUl);
            await this._renderInto(childUl, entry.path);
          }
        } else if (childUl) {
          childUl.remove();
        }
      });
    } else {
      const file = Icon.render(this._iconForFile(entry.name));
      const name = document.createElement('span');
      name.textContent = entry.name;
      row.append(document.createElement('span'), file, name); // empty span to align with toggle column
      row.firstElementChild.className = 'ide-icon ide-icon-toggle';
      row.addEventListener('click', () => {
        this._selectRow(row);
        this.onOpen?.(entry);
      });
    }
    li.appendChild(row);
    return li;
  }

  /**
   * Resolve a file icon spec from the configured `file_icons` map.
   * Lookup order: full filename (lower-case) → extension (lower-case) → default.
   *
   * @param {string} name
   * @returns {string}
   */
  _iconForFile(name) {
    const lower = String(name || '').toLowerCase();
    const byName = this.fileIcons.by_name || {};
    if (Object.prototype.hasOwnProperty.call(byName, lower)) {
      return byName[lower];
    }
    const dot = lower.lastIndexOf('.');
    if (dot > 0 && dot < lower.length - 1) {
      const ext = lower.slice(dot + 1);
      const byExt = this.fileIcons.by_ext || {};
      if (Object.prototype.hasOwnProperty.call(byExt, ext)) {
        return byExt[ext];
      }
    }
    return this.fileIcons.default || 'fa fa-file-o';
  }

  _selectRow(row) {
    this.host.querySelectorAll('.row.selected').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
  }
}
