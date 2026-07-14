/**
 * Wrapper over fetch with consistent JSON-envelope handling.
 *
 * Success: `{ data: ... }` → returned as `.data`
 * Error: `{ error: {code, message, details} }` → thrown as ApiError
 */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details || {};
  }
}

export class ApiClient {
  constructor(basePath, workspaceAlias) {
    this.base = basePath.replace(/\/$/, '');
    this.workspace = workspaceAlias;
    this._requestObserver = null;
    this._inflight = 0;
  }

  setRequestObserver(observer) {
    this._requestObserver = typeof observer === 'function' ? observer : null;
  }

  _notifyRequest(event) {
    try {
      this._requestObserver?.(event);
    } catch (error) {
      console.warn('[ApiClient] request observer failed:', error);
    }
  }

  /**
   * Build one request URL with the current workspace root and arbitrary query
   * values, preserving repeated keys such as `paths[]` for bulk downloads.
   */
  url(path, query = {}) {
    const q = new URLSearchParams();
    if (this.workspace && query.root === undefined) q.set('root', this.workspace);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        v.forEach((item) => {
          if (item === undefined || item === null) return;
          q.append(k, String(item));
        });
        continue;
      }
      q.append(k, String(v));
    }
    const qs = q.toString();
    return this.base + path + (qs ? '?' + qs : '');
  }

  async request(method, path, { query, json, body, headers, signal, raw } = {}) {
    const opts = { method, headers: { 'Accept': 'application/json', ...(headers || {}) }, signal };
    if (json !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(json);
    } else if (body !== undefined) {
      opts.body = body;
    }
    this._inflight += 1;
    this._notifyRequest({ phase: 'start', method, path, inflight: this._inflight });
    try {
      const res = await fetch(this.url(path, query || {}), opts);
      if (raw) return res;
      const text = await res.text();
      let payload = null;
      if (text.length) {
        try { payload = JSON.parse(text); }
        catch { throw new ApiError(res.status, 'bad_json', 'Server returned malformed JSON.', { text }); }
      }
      if (!res.ok) {
        const err = (payload && payload.error) || {};
        throw new ApiError(res.status, err.code || 'http_' + res.status, err.message || res.statusText, err.details);
      }
      return payload ? payload.data : null;
    } finally {
      this._inflight = Math.max(0, this._inflight - 1);
      this._notifyRequest({ phase: 'end', method, path, inflight: this._inflight });
    }
  }

  get(p, q) { return this.request('GET', p, { query: q }); }
  delete(p, q) { return this.request('DELETE', p, { query: q }); }
  post(p, json, q) { return this.request('POST', p, { json, query: q }); }
  put(p, json, q) { return this.request('PUT', p, { json, query: q }); }
}
