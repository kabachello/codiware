/** Lightweight toast notifications. */
export class Toasts {
  constructor() {
    this.host = document.createElement('div');
    this.host.className = 'toast-host';
    document.body.appendChild(this.host);
  }

  show(message, kind = 'info', ttl = 4000) {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = message;
    this.host.appendChild(el);
    if (ttl > 0) setTimeout(() => el.remove(), ttl);
    return el;
  }

  info(m, ttl) { return this.show(m, 'info', ttl); }
  success(m, ttl) { return this.show(m, 'success', ttl); }
  error(m, ttl = 6000) { return this.show(m, 'error', ttl); }
}
