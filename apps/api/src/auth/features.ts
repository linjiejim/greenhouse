/**
 * Feature-flag resolution (server side).
 *
 * Registry + resolution rules live in @greenhouse/types/features. This module
 * resolves a user's effective feature state against the `user_features` table,
 * applying super-bypass and per-flag defaults.
 *
 * Used by:
 *   • requireFeature() middleware  — gates /api/<x>/* routes
 *   • /api/auth/me + /me/features  — tells the web app what to show
 */

import { getDb } from '@greenhouse/db';
import { FEATURE_FLAGS, featureDefault } from '@greenhouse/types/features';
import type { UserRole } from './token.js';

/**
 * Resolve the effective enabled-state of every registry feature for a user.
 *   super        → all features enabled
 *   explicit row → row.enabled
 *   no row       → flag.defaultEnabled
 */
export async function resolveUserFeatures(userId: string, role: UserRole): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};

  if (role === 'super') {
    for (const flag of FEATURE_FLAGS) result[flag.key] = true;
    return result;
  }

  let explicit = new Map<string, boolean>();
  try {
    const rows = await getDb().userFeatures.listByUser(userId);
    explicit = new Map(rows.map((r) => [r.feature, r.enabled]));
  } catch {
    /* DB unavailable — fall back to defaults */
  }

  for (const flag of FEATURE_FLAGS) {
    result[flag.key] = explicit.has(flag.key) ? explicit.get(flag.key)! : featureDefault(flag.key);
  }
  return result;
}

/** Whether a user may access a specific feature (super always passes). */
export async function userHasFeature(userId: string, role: UserRole, feature: string): Promise<boolean> {
  if (role === 'super') return true;
  const features = await resolveUserFeatures(userId, role);
  return features[feature] ?? featureDefault(feature);
}
