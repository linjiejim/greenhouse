/**
 * Feature-flag gating for the web app.
 *
 * The registry lives in @greenhouse/types/features. Per-user state arrives on
 * `AuthenticatedUser.features` (resolved server-side by /api/auth/me, already
 * incl. super-bypass + per-flag defaults). This helper is the one place the UI
 * decides whether to show a gated tab / route / nav entry.
 *
 * Note: hiding UI here is convenience only — the API enforces access via
 * `requireFeature()`. Never rely on this for security.
 */

import type { AuthenticatedUser } from '@greenhouse/types/api';

/**
 * Whether the current user may see/use a gated feature.
 * Super (and dev-mode super, which has no `features` map) always passes.
 */
export function canUseFeature(user: AuthenticatedUser | null | undefined, key: string): boolean {
  if (!user) return false;
  if (user.role === 'super') return true;
  return user.features?.[key] === true;
}
