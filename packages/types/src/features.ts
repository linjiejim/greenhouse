/**
 * Feature flags — per-user experimental feature registry.
 *
 * SINGLE SOURCE OF TRUTH for which gated / experimental features exist.
 * Consumed by:
 *   • apps/api — `requireFeature()` middleware + `/api/auth/me` resolution
 *                (apps/api/src/auth/features.ts)
 *   • apps/web — admin toggle UI (settings/users.tsx) + nav / route gating
 *                (apps/web/src/lib/features.ts)
 *
 * ─── How gating resolves ─────────────────────────────────
 * Per-user state lives in the `user_features` DB table (one row per
 * user × feature, with an `enabled` boolean). Effective access is:
 *
 *     super role            → always enabled (admins see everything)
 *     explicit row present  → row.enabled
 *     no row                → flag.defaultEnabled  (default false)
 *
 * So `defaultEnabled: false` is an OPT-IN allowlist: hidden for everyone
 * until a super grants it per user in Settings → Users → Features.
 * `defaultEnabled: true` is opt-OUT: on for all internal users unless a
 * super explicitly disables it for someone.
 *
 * ─── Adding a new experimental feature ───────────────────
 *   1. Add an entry to FEATURE_FLAGS below (key + label + description).
 *      The per-user admin toggle then appears automatically.
 *   2. Gate the backend (UI hiding is NOT access control):
 *        app.use('/api/<x>/*', requireFeature('<key>'))   // apps/api/src/index.ts
 *   3. Gate the UI around the tab / route / nav entry:
 *        canUseFeature(currentUser, '<key>')               // apps/web/src/lib/features.ts
 */

export interface FeatureFlag {
  /** Stable key, stored verbatim in `user_features.feature`. Never rename. */
  key: string;
  /** Human label shown in the admin toggle UI. */
  label: string;
  /** What the feature unlocks (shown under the label). */
  description: string;
  /**
   * Effective state for a user with no explicit row.
   * false (default) = opt-in allowlist; true = opt-out (on unless disabled).
   */
  defaultEnabled?: boolean;
}

export const FEATURE_FLAGS = [
  {
    key: 'memory',
    label: 'AI Memory',
    description: 'Agent learns and remembers user preferences across sessions',
  },
  {
    key: 'sync',
    label: 'Knowledge Sync',
    description: 'Sync the knowledge base / wiki from external sources (sync panel, run history)',
  },
  {
    key: 'im_gateway',
    label: 'IM Gateway (Telegram)',
    description: 'Connect a chat platform (Telegram) and talk to your agent from it — deep-link pairing',
  },
] as const satisfies readonly FeatureFlag[];

/** Union of CORE feature keys, e.g. 'memory' | 'sync'. Fork-registered keys are
 *  plain strings resolved at runtime (see getAllFeatureFlags), not in this union. */
export type FeatureKey = (typeof FEATURE_FLAGS)[number]['key'];

/** All CORE registry keys as a plain string array. */
export const FEATURE_FLAG_KEYS: readonly string[] = FEATURE_FLAGS.map((f) => f.key);

// ─── Fork extension point ────────────────────────────────
// @greenhouse/types is a versioned package a fork consumes over npm and cannot
// edit, so a fork registers its private gated features (e.g. 'crm') at startup
// via registerFeatureFlags(). Empty upstream. Consumers that must include fork
// flags (per-user resolution, the admin toggle list) read getAllFeatureFlags();
// getFeatureFlag/featureDefault below already do.

const extensionFeatureFlags: FeatureFlag[] = [];

/** Register private feature flags contributed by a downstream fork (call at startup). */
export function registerFeatureFlags(flags: FeatureFlag[]): void {
  extensionFeatureFlags.push(...flags);
}

/** Core flags plus any fork-registered flags. Empty-extension upstream ⇒ just core. */
export function getAllFeatureFlags(): readonly FeatureFlag[] {
  return extensionFeatureFlags.length ? [...FEATURE_FLAGS, ...extensionFeatureFlags] : FEATURE_FLAGS;
}

/** Look up a flag's metadata by key (core + fork-registered). */
export function getFeatureFlag(key: string): FeatureFlag | undefined {
  return getAllFeatureFlags().find((f) => f.key === key);
}

/** Effective state for a user that has no explicit `user_features` row. */
export function featureDefault(key: string): boolean {
  return getFeatureFlag(key)?.defaultEnabled ?? false;
}
