/**
 * Does this station speak the API this app needs? Pure (./compat.test.ts).
 *
 * `GET /api/bootstrap` is public and answers `mobile_api` — the level of the API the phone app
 * relies on (apps/api/src/routes/bootstrap.ts `MOBILE_API_LEVEL`). Below `MOBILE_API` the
 * server lacks endpoints this app calls ("the server needs updating"). A body with `api_version`
 * is a Greenhouse 2 server, whose API this app does not speak. Either way the app says so instead
 * of failing screen by screen. An unreadable answer is not a verdict: the app tries and the calls
 * themselves fail.
 */

import type { Bootstrap } from '../shared/greenhouse-types';

/** The API level this build needs: 2 = password and Feishu sign-in, notifications, push devices. */
export const MOBILE_API = 2;

export type ApiMismatch = 'server_outdated' | 'unsupported';

/** A `/api/bootstrap` body, or null when it is not a Greenhouse one. */
export function parseBootstrap(body: unknown): Bootstrap | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (!('product_name' in value)) return null;
  const tokens = value.theme_tokens;
  return {
    product_name: typeof value.product_name === 'string' && value.product_name.trim() ? value.product_name : null,
    logo: typeof value.logo === 'string' && value.logo.startsWith('data:image/') ? value.logo : null,
    theme_tokens:
      tokens && typeof tokens === 'object' && !Array.isArray(tokens) ? (tokens as Record<string, string>) : null,
    ...(typeof value.mobile_api === 'number' ? { mobile_api: value.mobile_api } : {}),
  };
}

/** What a bootstrap body says about this app and that server; null when they match or it is unclear. */
export function apiMismatch(body: unknown): ApiMismatch | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (typeof (body as { api_version?: unknown }).api_version === 'number') return 'unsupported';
  const boot = parseBootstrap(body);
  if (!boot) return null;
  return (boot.mobile_api ?? 0) < MOBILE_API ? 'server_outdated' : null;
}
