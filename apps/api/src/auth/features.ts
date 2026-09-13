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
import type { DatabaseProvider } from '@greenhouse/db';
import { FEATURE_FLAGS, featureDefault } from '@greenhouse/types/features';
import type { UserRole } from './token.js';

/**
 * Resolve the effective enabled-state of every registry feature for a user.
 *   super        → all features enabled
 *   explicit row → row.enabled
 *   no row       → flag.defaultEnabled
 *
 * This resolver is the ONLY correct way to answer "does user X have feature Y".
 * The raw `db.userFeatures.isEnabled` table read knows neither the super bypass
 * nor `defaultEnabled` — a default-ON flag has no row for anyone, so the raw
 * read returns false for the whole team (how memory v1 shipped dead).
 */
export async function resolveUserFeatures(
  userId: string,
  role: UserRole,
  db: DatabaseProvider = getDb(),
): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};

  if (role === 'super') {
    for (const flag of FEATURE_FLAGS) result[flag.key] = true;
    return result;
  }

  let explicit = new Map<string, boolean>();
  try {
    const rows = await db.userFeatures.listByUser(userId);
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
export async function userHasFeature(
  userId: string,
  role: UserRole,
  feature: string,
  db: DatabaseProvider = getDb(),
): Promise<boolean> {
  if (role === 'super') return true;
  const features = await resolveUserFeatures(userId, role, db);
  return features[feature] ?? featureDefault(feature);
}
