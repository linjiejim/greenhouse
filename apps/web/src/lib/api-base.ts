/**
 * API URL resolution for the web application.
 *
 * Deployments share this one bundle, in precedence order:
 *
 * 1. **Split hosting** — `GREENHOUSE_API_BASE_URL` is a build-time override for
 *    serving the SPA from a different origin than the API.
 * 2. **Same-origin** — the default; the API serves this bundle itself (and the
 *    Vite dev server proxies `/api`, `/public` and `/health` to it).
 */

declare const __GREENHOUSE_API_BASE_URL__: string | undefined;

/**
 * Paths the API owns. `/public` is included because uploads and runtime assets are
 * served by the API, not bundled.
 */
const API_PATH_RE = /^(\/api(?:\/|\?|$)|\/public(?:\/|\?|$)|\/health(?:\?|$))/;
const ABSOLUTE_URL_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

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

/** Return the remote API origin when one is needed; empty string means same-origin. */
export function getApiBaseUrl(): string {
  return getBuildTimeApiBase();
}

export function shouldUseApiBase(path: string): boolean {
  return API_PATH_RE.test(path);
}

/** Convert API-owned paths to an absolute URL when a base is configured. */
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

/** Resolve a runtime asset served by the API under `/public/*`. */
export function publicAssetUrl(path: string): string {
  const clean = path.replace(/^\/?public\//, '').replace(/^\//, '');
  return apiUrl(`/public/${clean}`);
}

/** Build a WebSocket URL for an API path such as `/api/ws`. */
export function apiWebSocketUrl(path: string): string {
  const base = getApiBaseUrl();
  if (base) {
    const joined = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    const url = ABSOLUTE_URL_RE.test(joined)
      ? new URL(joined)
      : new URL(joined, `${location.protocol}//${location.host}`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${path.startsWith('/') ? path : `/${path}`}`;
}
