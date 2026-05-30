/**
 * Minimal pub/sub bus used to wire features without hard imports.
 * Events are arbitrary string topics; subscribers receive a single payload.
 */
export class EventBus {
  constructor() { this.listeners = new Map(); }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    const set = this.listeners.get(event);
    if (set) set.delete(fn);
  }

  emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); }
      catch (e) { console.error('[EventBus]', event, e); }
    }
  }
}
