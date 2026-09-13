/**
 * HTML escaping for strings we interpolate into markup we compose ourselves.
 *
 * The two callers are both email builders (`account-security.ts`, the delivery
 * renderer), and both are interpolating text they did not write — a user's
 * nickname, an agent's answer — into a document a mail client will parse.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}
