/** Serializes host writes without treating edits made during a write as saved. */
export class SaveQueue {
  constructor() {
    this.resources = new Map();
  }

  /** Repeated shortcuts request at most one freshly prepared trailing snapshot. */
  request(resource, operation) {
    let state = this.resources.get(resource);
    if (state) {
      state.next = operation;
      return state.promise;
    }
    state = { next: operation, promise: null };
    this.resources.set(resource, state);
    state.promise = Promise.resolve().then(async () => {
      while (state.next) {
        const current = state.next;
        state.next = null;
        const snapshot = await current.prepare();
        if (!snapshot) continue;
        await current.write(snapshot);
        current.acknowledge(snapshot);
      }
    }).finally(() => {
      this.resources.delete(resource);
    });
    return state.promise;
  }

  /** Identity-changing operations must not race a write already sent to disk. */
  async settle(resource) {
    const state = this.resources.get(resource);
    if (state) {
      state.next = null;
      await state.promise;
    }
  }
}