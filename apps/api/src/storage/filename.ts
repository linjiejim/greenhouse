/**
 * File-name hygiene for anything a user or an agent names.
 *
 * Shared by the Cloud Agent surface (artifact paths out, attachment names in)
 * and chat attachments, because they are the same problem and a second copy
 * would drift — the ASCII-only version of this regex is exactly what silently
 * 400'd every CJK-named deliverable on 2026-07-31.
 */

/**
 * One path segment, **normalized rather than rejected**. Unsafe characters
 * collapse to `_`; null only when nothing usable survives.
 *
 * ⚠️ Do not narrow this back to ASCII. It used to be
 * `/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/`, which refused a 29-minute mission's
 * `ECT说明书_..._审校报告.html` over its name alone while its ASCII-named
 * sibling went through — the agent had written the file and truthfully
 * reported success, the user just never got a card. In a product whose
 * conversations are in Chinese, people and agents name files in Chinese.
 */
export function sanitizeFileSegment(raw: string): string | null {
  const cleaned = raw.replace(/[^\w.\- ()一-鿿]/g, '_').trim();
  if (!cleaned || /^\.+$/.test(cleaned) || cleaned.length > 120) return null;
  return cleaned;
}

/** Strip any directory part, then normalize what's left. */
export function sanitizeUploadName(raw: string): string | null {
  return sanitizeFileSegment(raw.split(/[/\\]/).pop() ?? '');
}
