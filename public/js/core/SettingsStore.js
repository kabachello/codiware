/**
 * Persistent per-user IDE settings backed by the browser `localStorage`.
 *
 * Why `localStorage`?
 * - It survives page reloads and full browser restarts, which is what we want
 *   for UI preferences (theme, panel sizes, open folders). `sessionStorage`
 *   would forget everything when the tab closes; cookies are sent on every
 *   request, are size-limited and inappropriate for client-only state; and
 *   IndexedDB is asynchronous and overkill for a handful of small values.
 * - The Codiware package does not own user sessions (auth is delegated to the
 *   host), so there is no server-side place to keep per-user UI state anyway.
 *
 * Two scopes are offered:
 * - `global`  – shared across all repositories/workspaces of one installation
 *               (for example the dark/light theme).
 * - `repo`    – scoped to a single workspace/repository (for example the set
 *               of expanded folders in the tree or panel widths).
 *
 * Keys are namespaced with the installation base path so that several Codiware
 * instances served from different URL prefixes on the same origin do not
 * collide. Values are JSON-encoded. All access is wrapped in try/catch so the
 * IDE keeps working when storage is unavailable (private mode, quota, etc.).
 */
export class SettingsStore {
  /**
   * @param {object}  [options]
   * @param {string}  [options.install]   Installation namespace (base path/api prefix).
   * @param {string}  [options.workspace] Current workspace/repo id for the `repo` scope.
   * @param {Storage} [options.storage]   Storage backend, defaults to `window.localStorage`.
   */
  constructor({ install = '', workspace = '', storage } = {}) {
    this._install = String(install || '');
    this._workspace = String(workspace || 'default');
    this._storage = storage || this._detectStorage();
  }

  /** @returns {Storage|null} A working storage backend or null when unavailable. */
  _detectStorage() {
    try {
      const s = window.localStorage;
      const probe = '__codiware_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch {
      return null;
    }
  }

  /** Update the workspace used for the `repo` scope (e.g. after switching repos). */
  setWorkspace(workspace) {
    this._workspace = String(workspace || 'default');
  }

  /** @returns {string} Storage key for a globally scoped setting. */
  _globalKey(name) {
    return `codiware:${this._install}:global:${name}`;
  }

  /** @returns {string} Storage key for a workspace-scoped setting. */
  _repoKey(name) {
    return `codiware:${this._install}:repo:${this._workspace}:${name}`;
  }

  /** Read a JSON value for the given key, returning `fallback` on miss/error. */
  _read(key, fallback) {
    if (!this._storage) return fallback;
    try {
      const raw = this._storage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  /** Write a JSON value for the given key. Silently ignores storage errors. */
  _write(key, value) {
    if (!this._storage) return;
    try {
      this._storage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full or unavailable – ignore */
    }
  }

  /** Read a setting shared across all workspaces. */
  getGlobal(name, fallback = null) {
    return this._read(this._globalKey(name), fallback);
  }

  /** Persist a setting shared across all workspaces. */
  setGlobal(name, value) {
    this._write(this._globalKey(name), value);
  }

  /** Read a setting scoped to the current workspace/repo. */
  getRepo(name, fallback = null) {
    return this._read(this._repoKey(name), fallback);
  }

  /** Persist a setting scoped to the current workspace/repo. */
  setRepo(name, value) {
    this._write(this._repoKey(name), value);
  }
}
