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

/**
 * Whether this account may list and open other members' ordinary chats — the chat history's "Team"
 * tab (spec 20261011-agent-first-class D46). Not a role check: a super reads them only where the
 * deployment allows it (`SUPER_READS_CHATS`), and the API says so in `reads_team_chats` on the
 * signed-in user. Absent (an older server) = no: asking would 403.
 */
export function readsTeamChats(user: AuthenticatedUser | null | undefined): boolean {
  // Read by name: the shared AuthenticatedUser type does not declare the field yet.
  return !!user && 'reads_team_chats' in user && user.reads_team_chats === true;
}
