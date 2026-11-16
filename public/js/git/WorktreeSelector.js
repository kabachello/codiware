import { Icon } from '../core/Icon.js';
import { PopupMenu } from '../core/PopupMenu.js';

export class WorktreeSelector {
  constructor({ api, i18n, toasts, bus, boot, canSwitch }) {
    Object.assign(this, { api, i18n, toasts, bus, boot, canSwitch });
    this.el = document.createElement('div');
    this.el.className = 'ide-status-git';
    this.el.style.display = 'none';
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'ide-status-git-branch';
    this.button.title = i18n.t('git.select_worktree');
    this.button.setAttribute('aria-label', this.button.title);
    const label = document.createElement('span');
    label.className = 'ide-status-git-branch-name';
    label.textContent = boot.worktree || i18n.t('git.main_worktree');
    this.button.append(Icon.render(Icon.worktree), label, Icon.render('fa fa-caret-down'));
    this.button.addEventListener('click', () => this.openMenu());
    const separator = document.createElement('span');
    separator.className = 'ide-status-sep';
    separator.textContent = '|';
    this.el.append(separator, this.button);
  }

  async refresh() {
    this.trees = await this.api.get('/git/worktrees');
    this.el.style.display = this.trees.some(tree => !tree.main) ? '' : 'none';
    return this.trees;
  }

  async openMenu(anchor = this.button) {
    if (this.loading) return;
    this.loading = true;
    PopupMenu.open(anchor, [{ label: this.i18n.t('git.loading_worktrees'), disabled: true }]);
    try {
      const trees = await this.refresh();
      PopupMenu.open(anchor, this.menuItems(trees));
    } catch (error) {
      PopupMenu.open(anchor, [{ icon: 'fa fa-exclamation-triangle', label: error.message, disabled: true }]);
      this.showError(error);
    } finally {
      this.loading = false;
    }
  }

  menuItems(trees) {
    const items = trees.map(tree => {
      const current = tree.main ? !this.boot.worktree : tree.title === this.boot.worktree;
      const title = tree.main ? this.i18n.t('git.main_worktree') : tree.title;
      return {
        icon: current ? 'fa fa-bullseye' : Icon.worktree,
        label: title + (current ? this.i18n.t('git.current_branch_suffix') : ''),
        children: [
          {
            icon: Icon.switchWorktree, label: this.i18n.t('git.switch_worktree'),
            disabled: current || tree.missing,
            onClick: () => this.switchTo(tree.main ? null : tree.title),
          },
          {
            icon: 'fa fa-trash-o', label: this.i18n.t('git.delete_worktree'),
            disabled: tree.main || current || tree.locked || tree.missing,
            onClick: () => this.deleteWorktree(tree.title),
          },
          {
            icon: 'fa fa-trash-o', label: this.i18n.t('git.delete_worktree_branch'),
            disabled: tree.main || current || tree.locked || tree.missing || !tree.branch,
            onClick: () => this.deleteWorktree(tree.title, tree.branch),
          },
        ],
      };
    });
    items.push({ sep: true }, {
      icon: 'fa fa-plus', label: this.i18n.t('git.create_worktree'), onClick: () => this.createWorktree(),
    });
    return items;
  }

  switchTo(title) {
    if (!this.canSwitch()) return;
    const url = new URL(window.location.href);
    // Keep the host-facing app alias rather than the server's normalized package path.
    const repoPrefix = this.api.base + '/repo/';
    const repoPath = url.pathname.slice(repoPrefix.length)
      .replace(/\/worktrees\/[^/]+\/?$/, '').replace(/\/+$/, '');
    url.pathname = repoPrefix + repoPath + (title ? `/worktrees/${encodeURIComponent(title)}/` : '');
    url.searchParams.delete('branch');
    url.searchParams.delete('worktree');
    window.location.assign(url.href);
  }

  async createWorktree() {
    const title = window.prompt(this.i18n.t('git.prompt_create_worktree'));
    if (title === null) return;
    try {
      const result = await this.api.post('/git/create-worktree', { title: title.trim() });
      this.bus.emit('console:inject', result.console);
      this.toasts.success(this.i18n.t('git.created_worktree', { title: result.title }));
      await this.refresh();
    } catch (error) { this.showError(error); }
  }

  async deleteWorktree(title, branch = null) {
    if (!window.confirm(this.i18n.t(branch ? 'git.confirm_delete_worktree_branch' : 'git.confirm_delete_worktree', { title, branch }))) return;
    try {
      const result = await this.api.post('/git/delete-worktree', branch ? { title, branch } : { title });
      this.bus.emit('console:inject', result.console);
      this.toasts.success(this.i18n.t(branch ? 'git.deleted_worktree_branch' : 'git.deleted_worktree', { title, branch }));
    } catch (error) { this.showError(error); }
    try {
      await this.refresh();
    } catch (error) { this.showError(error); }
  }

  showError(error) {
    if (error.details?.console) {
      this.bus.emit('console:inject', { ...error.details.console, ok: false, autoOpen: true });
    }
    this.toasts.error(error.message);
  }
}
