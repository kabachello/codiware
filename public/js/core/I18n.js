/**
 * Tiny i18n. Holds a flat `{key: text}` map. Unknown keys fall back to the key.
 * `{name}` placeholders in messages are replaced from the values object.
 */
export class I18n {
  constructor(messages = {}) { this.messages = messages; }

  setMessages(m) { this.messages = m || {}; }

  t(key, values) {
    let msg = this.messages[key];
    if (msg === undefined) msg = key;
    if (values) {
      for (const [k, v] of Object.entries(values)) {
        msg = msg.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
      }
    }
    return msg;
  }
}
