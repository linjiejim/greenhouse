/**
 * Is this station new enough for this app? Pure (./bootstrap.test.ts).
 *
 * `GET /api/bootstrap` is public and answers `mobile_api`, the level of the API the client relies
 * on (apps/api/src/routes/bootstrap.ts `MOBILE_API_LEVEL`). A Greenhouse below `CLIENT_API_LEVEL`
 * (any 3.x station) lacks the station manifest and plugin surfaces this app needs, so the app asks
 * for a station update instead of failing screen by screen. An unreadable answer is not a verdict:
 * the app tries and the calls themselves fail.
 */

import type { Bootstrap } from '../shared/greenhouse-types';
import { CLIENT_API_LEVEL } from '../shared/plugins';

export type ApiMismatch = 'server_outdated';

/** A `/api/bootstrap` body, or null when it is not a Greenhouse one. */
export function parseBootstrap(body: unknown): Bootstrap | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (!('product_name' in value)) return null;
  const tokens = value.theme_tokens;
  return {
    setup_pending: value.setup_pending === true,
    product_name: typeof value.product_name === 'string' && value.product_name.trim() ? value.product_name : null,
    logo: typeof value.logo === 'string' && value.logo.startsWith('data:image/') ? value.logo : null,
    theme_tokens:
      tokens && typeof tokens === 'object' && !Array.isArray(tokens) ? (tokens as Bootstrap['theme_tokens']) : null,
    ...(typeof value.mobile_api === 'number' ? { mobile_api: value.mobile_api } : {}),
  };
}

/** `server_outdated` when a Greenhouse answers below the level this app needs; null when it matches or is unclear. */
export function apiMismatch(body: unknown): ApiMismatch | null {
  const boot = parseBootstrap(body);
  if (!boot) return null;
  return (boot.mobile_api ?? 0) < CLIENT_API_LEVEL ? 'server_outdated' : null;
}
