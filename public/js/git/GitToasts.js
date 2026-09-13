/**
 * Shared formatting for concise Git notifications.
 *
 * Git command output remains available in the console; toasts keep only the
 * operation, branch/commit metadata and the first useful output line.
 */
export class GitToasts {
  static success(operation, response = {}, context = {}) {
    const op = String(operation || '').toLowerCase();
    const branch = response?.branch || context?.branch || null;
    const commits = Number.isFinite(Number(response?.commits)) ? Math.max(0, Number(response.commits)) : null;
    const count = commits === null ? null : `${commits} ${commits === 1 ? 'commit' : 'commits'}`;

    if (op === 'push') {
      if (commits === 0) return `Nothing to push; branch ${branch || '(detached)'} is up to date ✓`;
      return `Pushed${count ? ` ${count}` : ''} from branch ${branch || '(detached)'} ✓`;
    }
    if (op === 'pull') {
      if (commits === 0) return `No commits pulled; branch ${branch || '(detached)'} is up to date ✓`;
      return `Pulled${count ? ` ${count}` : ''} into branch ${branch || '(detached)'} ✓`;
    }
    if (op === 'commit' || op === 'amend') {
      return `${op === 'amend' ? 'Amended' : 'Committed'}${branch ? ` on branch ${branch}` : ''} ✓`;
    }

    const label = context?.label || GitToasts._operationLabel(op);
    const detail = context?.detail === false ? '' : GitToasts._firstUsefulLine(response?.message || response?.console?.output);
    return `${label}${detail ? `: ${detail}` : ''} ✓`;
  }

  static error(error, operation = '') {
    const output = error?.details?.console?.output;
    const detail = GitToasts._firstUsefulLine(output || error?.message);
    const label = operation ? `Git ${String(operation).replace(/-/g, ' ')} failed` : 'Git operation failed';
    return detail && !detail.toLowerCase().startsWith(label.toLowerCase()) ? `${label}: ${detail}` : (detail || label);
  }

  static _operationLabel(operation) {
    const labels = {
      fetch: 'Updated remote branches and tags',
      checkout: 'Switched branch',
      merge: 'Merged',
      'create-branch': 'Created branch',
      'delete-branch': 'Deleted branch',
      'cherry-pick': 'Cherry-picked commit',
      revert: 'Reverted commit',
      reset: 'Reset branch',
    };
    return labels[operation] || 'Git operation completed';
  }

  static _firstUsefulLine(value) {
    const text = String(value || '')
      .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
      .replace(/\r/g, '');
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return '';
    const preferred = lines.find((line) => /^(fatal:|error:|warning:|remote:|To |From |Already up.to.date|Updating |Fast-forward|\[)/i.test(line)) || lines[0];
    return preferred.length > 240 ? `${preferred.slice(0, 237)}…` : preferred;
  }
}