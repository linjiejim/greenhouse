/**
 * RFC 6266 `Content-Disposition` for downloads — the single implementation.
 *
 * `filename=` is ASCII-only, so a CJK name put there percent-encoded reaches the
 * user literally as `ECT%E8%AF%B4...txt`; the UTF-8 name has to ride in
 * `filename*`. Both are emitted — modern browsers prefer `filename*`, anything
 * else falls back to the sanitized ASCII form.
 *
 * Zero imports on purpose: every download route can reach it without pulling a
 * module graph along.
 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
