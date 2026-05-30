/**
 * Tiny observable state container.
 * Components subscribe to keys and receive notifications when they change.
 */
export class StateStore {
  constructor(initial = {}) {
    this._state = { ...initial };
    this._subs = new Map();
  }

  get(key) { return this._state[key]; }

  set(key, value) {
    const old = this._state[key];
    if (old === value) return;
    this._state[key] = value;
    const subs = this._subs.get(key);
    if (subs) for (const fn of [...subs]) fn(value, old);
  }

  update(key, fn) { this.set(key, fn(this._state[key])); }

  subscribe(key, fn) {
    if (!this._subs.has(key)) this._subs.set(key, new Set());
    this._subs.get(key).add(fn);
    return () => this._subs.get(key)?.delete(fn);
  }
}
