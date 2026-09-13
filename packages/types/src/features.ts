/**
 * Feature flags — per-user experimental feature registry.
 *
 * SINGLE SOURCE OF TRUTH for which gated / experimental features exist.
 * Consumed by:
 *   • apps/api — `requireFeature()` middleware + `/api/auth/me` resolution
 *                (apps/api/src/auth/features.ts); flags additionally gate the
 *                chat/proxy tools that ride them via resolveUserTools + the
 *                feature-point registry (apps/api/src/platform/feature-points.ts)
 *   • apps/web — per-user admin toggle in the unified permission modal
 *                (settings/user-permissions-modal.tsx) + nav / route gating
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
 * until a super grants it per user in Settings → Users → (user) → Permissions.
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
    // On for everyone unless explicitly disabled — memory is only useful if it
    // accumulates, and an opt-in allowlist kept it empty for its entire v1 life.
    defaultEnabled: true,
  },
  {
    key: 'tables',
    label: 'Tables',
    description: 'Internal multidimensional tables, shared grid views, dashboards, REST, and MCP access',
    // Baseline capability (2026-08-14): on for every internal user; super can
    // still disable it per user in the permissions modal.
    defaultEnabled: true,
  },
  {
    key: 'cloud-agent',
    label: 'Missions',
    description: 'Long-running missions in disposable sandboxes with a persistent workspace',
    // Baseline capability (2026-08-14) — same posture as `tables`. Runtime
    // admission (MISSION_ENABLED + sandbox prechecks) still gates execution.
    defaultEnabled: true,
  },
] as const satisfies readonly FeatureFlag[];

/** Union of known feature keys, e.g. 'memory' | 'tables'. */
export type FeatureKey = (typeof FEATURE_FLAGS)[number]['key'];

/** Look up a flag's metadata by key. */
export function getFeatureFlag(key: string): FeatureFlag | undefined {
  return FEATURE_FLAGS.find((f) => f.key === key);
}

/** Effective state for a user that has no explicit `user_features` row. */
export function featureDefault(key: string): boolean {
  return getFeatureFlag(key)?.defaultEnabled ?? false;
}
