/**
 * Editor registry. Maps file extension / mime to an editor factory.
 *
 * Extension authors call `registry.register(id, descriptor)` where descriptor is:
 * {
 *   id: string,
 *   label: string,
 *   accepts: (entry) => boolean,
 *   priority: number,
 *   create: (host, ctx) => editorInstance,
 * }
 *
 * The editor instance must implement:
 *   - load(content, meta)
 *   - getContent()
 *   - isDirty()
 *   - markClean()
 *   - destroy()
 *   - on(event, fn)      // optional, emits 'change', 'save-request', ...
 */
export class EditorRegistry {
  constructor() {
    this.entries = [];
  }

  register(descriptor) {
    if (!descriptor || !descriptor.id || typeof descriptor.create !== 'function') {
      throw new Error('Editor descriptor requires id and create()');
    }
    this.entries.push({ priority: 0, ...descriptor });
    this.entries.sort((a, b) => b.priority - a.priority);
  }

  /** Pick the best editor for an entry, or null if none match. */
  pick(entry) {
    for (const d of this.entries) {
      try {
        if (d.accepts && d.accepts(entry)) return d;
      } catch { /* ignore matcher errors */ }
    }
    return null;
  }
}
