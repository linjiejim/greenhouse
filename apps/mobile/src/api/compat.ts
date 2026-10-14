/**
 * Does this station speak the app's API? Pure (./compat.test.ts).
 *
 * `GET /api/bootstrap` is public and answers `api_version`. A station with a newer one needs a
 * newer app ("update the app"); one without it is a v1 server, which this app cannot use
 * ("the server needs updating"). Either way the app says so instead of failing screen by screen
 * (PRD §8.5). An unreadable answer is not a verdict: the app tries and the calls themselves fail.
 */

import { API_VERSION, type Bootstrap } from '../shared/contract';

export type ApiMismatch = 'app_outdated' | 'server_outdated';

/** A `/api/bootstrap` body as v2 shapes it, or null. */
export function parseBootstrap(body: unknown): Bootstrap | null {
  if (!body || typeof body !== 'object') return null;
  const value = body as Partial<Bootstrap>;
  if (typeof value.api_version !== 'number' || typeof value.name !== 'string') return null;
  return {
    api_version: value.api_version,
    name: value.name,
    primary_color: typeof value.primary_color === 'string' ? value.primary_color : null,
    logo_url: typeof value.logo_url === 'string' ? value.logo_url : null,
    login_methods: Array.isArray(value.login_methods) ? value.login_methods : ['password'],
    setup_pending: value.setup_pending === true,
  };
}

/** What a bootstrap body says about this app and that server; null when they match or it is unclear. */
export function apiMismatch(body: unknown): ApiMismatch | null {
  if (!body || typeof body !== 'object') return null;
  const version = (body as { api_version?: unknown }).api_version;
  if (typeof version === 'number') {
    if (version > API_VERSION) return 'app_outdated';
    if (version < API_VERSION) return 'server_outdated';
    return null;
  }
  // v1 answered `{ product_name, logo, theme_tokens }`: a Greenhouse, but the old one.
  return 'product_name' in body ? 'server_outdated' : null;
}
