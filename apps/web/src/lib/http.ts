/**
 * Small shared HTTP helpers built on top of `authFetch`.
 *
 * Typed API modules should use these instead of re-implementing query-string
 * building and JSON-with-error-handling per file.
 */

import { authFetch } from './auth';

/** Build a `?a=1&b=2` query string, dropping undefined/empty values. */
export function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

/** authFetch + JSON parse, throwing `data.error` (or a status message) on non-2xx. */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(url, init);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return res.json();
}
