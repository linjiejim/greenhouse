/**
 * API base URL resolution.
 *
 * Web deployment is same-origin and keeps using relative paths. A host shell may
 * inject an absolute backend origin (build-time or at runtime via window) for
 * file:// bundles; when none is set, paths stay relative (same-origin).
 */

declare const __GREENHOUSE_API_BASE_URL__: string | undefined;

const API_PATH_RE = /^(\/api(?:\/|\?|$)|\/health(?:\?|$))/;
const ABSOLUTE_URL_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

interface ApiBaseWindow extends Window {
  /** Preferred runtime override injected by a host shell, if any. */
  __GREENHOUSE_API_BASE_URL__?: string;
  /** Legacy override used by older settings code. */
  __API_BASE__?: string;
  /** Host-shell marker for a file:// bundle: { kind, bundled }. */
  __GREENHOUSE_BUNDLED__?: { kind: string; bundled: boolean };
}

function getWindow(): ApiBaseWindow | null {
  if (typeof window === 'undefined') return null;
  return window as ApiBaseWindow;
}

function normalizeBaseUrl(value: string | undefined | null): string {
  const trimmed = (value ?? '').trim();
  return trimmed.replace(/\/+$/, '');
}

function getBuildTimeApiBase(): string {
  try {
    return normalizeBaseUrl(typeof __GREENHOUSE_API_BASE_URL__ === 'string' ? __GREENHOUSE_API_BASE_URL__ : '');
  } catch {
    return '';
  }
}

function isBundledOrigin(w: ApiBaseWindow): boolean {
  // A host shell reports whether assets are served from a packaged file://
  // bundle (relative paths) vs the dev server (same-origin).
  return !!w.__GREENHOUSE_BUNDLED__?.bundled;
}

/** Return the remote API origin when one is needed; empty string means same-origin. */
export function getApiBaseUrl(): string {
  const w = getWindow();
  if (w) {
    if (typeof w.__GREENHOUSE_API_BASE_URL__ === 'string') return normalizeBaseUrl(w.__GREENHOUSE_API_BASE_URL__);
    if (typeof w.__API_BASE__ === 'string') return normalizeBaseUrl(w.__API_BASE__);
  }

  const buildTime = getBuildTimeApiBase();
  if (buildTime) return buildTime;

  return '';
}

export function shouldUseApiBase(path: string): boolean {
  return API_PATH_RE.test(path);
}

/** Convert `/api/*` and `/health` to an absolute backend URL when Desktop needs it. */
export function apiUrl(url: string): string {
  if (!url || ABSOLUTE_URL_RE.test(url) || url.startsWith('//')) return url;
  if (!shouldUseApiBase(url)) return url;

  const base = getApiBaseUrl();
  if (!base) return url;
  return `${base}${url.startsWith('/') ? url : `/${url}`}`;
}

/** Resolve fetch input while preserving non-API relative assets/routes. */
export function resolveFetchInput(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input === 'string') return apiUrl(input);
  if (input instanceof URL) return new URL(apiUrl(input.toString()));
  if (typeof Request !== 'undefined' && input instanceof Request) {
    const resolved = apiUrl(input.url);
    return resolved === input.url ? input : new Request(resolved, input);
  }
  return input;
}

/** Resolve a file from repo/public for the web server (`/public/*`) or a bundled file:// root (`./*`). */
export function publicAssetUrl(path: string): string {
  const clean = path.replace(/^\/?public\//, '').replace(/^\//, '');
  const w = getWindow();
  if (w && isBundledOrigin(w)) return `./${clean}`;
  return `/public/${clean}`;
}

/** Build a WebSocket URL for an API path such as `/api/ws`. */
export function apiWebSocketUrl(path: string): string {
  const base = getApiBaseUrl();
  if (base) {
    const url = new URL(path, base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${path.startsWith('/') ? path : `/${path}`}`;
}
