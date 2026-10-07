/**
 * The one authenticated file route a reply may point the app at —
 * `/api/chat-files/:id/content` (a Bot's browser screenshot, an export) —
 * and nothing else: a file artifact's `download_url` is a tool output, so a
 * tool (an extension's, a shared chat's client action) can put anything there.
 * Only the exact relative shape on the active station is ever fetched with the
 * member's bearer token: an absolute URL, `//host`, `@host` (which string
 * concatenation onto the station would turn into userinfo), `..` segments or a
 * query never qualify. Mirrors the web's guard (apps/web/src/components/files/
 * auth-image.tsx `isAuthImageSrc`, body-artifacts.tsx "Invalid chat file URL").
 *
 * Pure (no react-native): pinned by ./chat-file-url.test.ts.
 */

/** Exact shape, so nothing else rides the member's token. */
const CHAT_FILE_PATH = /^\/api\/chat-files\/[A-Za-z0-9_-]+\/content$/;

/** The trimmed chat-file path, or null when `value` is anything else. */
export function chatFilePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.trim();
  return CHAT_FILE_PATH.test(path) ? path : null;
}

/**
 * The absolute URL of chat file `value` on the station at `base` (built the
 * way `api()` builds every request, then checked to still be on the station's
 * origin), or null when `value` is not a chat-file path or `base` is not an
 * http(s) URL. Only a non-null result may carry the bearer token.
 */
export function chatFileUrl(value: unknown, base: string): string | null {
  const path = chatFilePath(value);
  if (!path) return null;
  const root = base.trim().replace(/\/+$/, '');
  let station: URL;
  let resolved: URL;
  try {
    station = new URL(root);
    resolved = new URL(`${root}${path}`);
  } catch {
    return null;
  }
  if (station.protocol !== 'https:' && station.protocol !== 'http:') return null;
  if (resolved.origin !== station.origin || resolved.search || resolved.hash || !resolved.pathname.endsWith(path)) {
    return null;
  }
  return resolved.href;
}
