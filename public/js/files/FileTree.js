import { Icon } from '../core/Icon.js';

/**
 * Recursive file tree using nested <ul> elements.
 * Each directory is loaded lazily through `api.get('/files/tree', {path})`.
 */
export class FileTree {
  constructor({ host, api, i18n, onOpen }) {
    this.host = host;
    this.api = api;
    this.i18n = i18n;
    this.onOpen = onOpen;
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
      const folder = Icon.render('fa fa-folder');
      const name = document.createElement('span');
      name.textContent = entry.name;
      row.append(toggle, folder, name);
      row.addEventListener('click', async () => {
        const open = li.classList.toggle('open');
        toggle.firstElementChild?.classList.toggle('fa-caret-right', !open);
        toggle.firstElementChild?.classList.toggle('fa-caret-down', open);
        folder.firstElementChild?.classList.toggle('fa-folder', !open);
        folder.firstElementChild?.classList.toggle('fa-folder-open', open);
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
      const file = Icon.render('fa fa-file-o');
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

  _selectRow(row) {
    this.host.querySelectorAll('.row.selected').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
  }
}
