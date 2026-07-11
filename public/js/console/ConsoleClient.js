/**
 * Transport for the console. Knows nothing about rendering — it only talks to
 * the `/console/*` endpoints.
 *
 * Two responsibilities:
 *   - `presets()`     — fetch the configured command presets (plain JSON).
 *   - `runStream()`   — POST a command and read its streamed output body
 *                       chunk-by-chunk, invoking `onChunk` as bytes arrive.
 *
 * Stopping a running command is done by aborting the streaming request via an
 * `AbortController`; the server-side generator detects the closed connection
 * and terminates the process. There is no dedicated stop endpoint.
 */
import { ApiError } from '../core/ApiClient.js';

export class ConsoleClient {
  /**
   * @param {import('../core/ApiClient.js').ApiClient} api
   */
  constructor(api) {
    this.api = api;
  }

  /** @returns {Promise<Array<{label:string,command:string}>>} */
  async presets() {
    const data = await this.api.get('/console/presets');
    return data?.presets || [];
  }

  /**
   * Submit a command and stream its output.
   *
   * @param {{command?:string, preset?:string}} payload
   * @param {{ signal?:AbortSignal, onChunk:(text:string)=>void }} opts
   * @returns {Promise<void>} Resolves when the stream ends (process finished).
   */
  async runStream(payload, { signal, onChunk }) {
    const res = await this.api.request('POST', '/console/run', { json: payload, signal, raw: true });

    if (!res.ok) {
      // The server rejected the command before streaming (e.g. denied/disabled).
      let code = 'http_' + res.status;
      let message = res.statusText;
      let details = {};
      try {
        const payloadErr = await res.json();
        const err = payloadErr?.error || {};
        code = err.code || code;
        message = err.message || message;
        details = err.details || {};
      } catch { /* non-JSON error body */ }
      throw new ApiError(res.status, code, message, details);
    }

    if (!res.body || typeof res.body.getReader !== 'function') {
      // No streaming support in this environment: fall back to a single read.
      const text = await res.text();
      if (text) onChunk(text);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) {
          onChunk(decoder.decode(value, { stream: true }));
        }
      }
      const tail = decoder.decode();
      if (tail) onChunk(tail);
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }
}
