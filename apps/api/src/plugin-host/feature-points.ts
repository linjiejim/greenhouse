/**
 * Feature-point registry + per-user access view (BFF/mapping layer).
 *
 * A "feature point" is the unit of "can this user use capability X", organized the
 * way an admin thinks (Knowledge / Projects / Tables / Memory / …) rather than by the
 * three underlying mechanisms it may land on:
 *
 *   • feature flag        (user_features)        — rollout gate      (memory, tables)
 *   • platform capability (platform_* overrides) — action authz      (knowledge.*, projects.*)
 *   • tool grant          (user_tools)           — chat/proxy tool   (admin opt-in tools)
 *
 * This registry is the SINGLE server-authoritative map. `buildUserAccessView`
 * composes the three mechanisms into one ready-to-render shape consumed by the
 * unified permission modal (Settings → Users → Permissions). Writes still go to
 * the existing granular endpoints — this module is read-only aggregation.
 */

import { resolveEntityPolicy, type FieldPolicy } from '@greenhouse/platform-kernel';
import { featureDefault } from '@greenhouse/types/features';
import { fromExtensions } from './index.js';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { getPlatformRuntime, PLATFORM_ORG_ID } from './runtime.js';
import { humanActor } from './actor.js';
import { TOOL_DEFINITIONS, getToolMeta, getGlobalToolIds, isInAppTool } from '../tools/registry.js';

// ─── Registry ────────────────────────────────────────────

type FeaturePointKind = 'app' | 'flag' | 'toolset';

/**
 * Which tab of the unified permission modal a point renders under:
 *   basic    — default-on baseline capabilities (defaultEnabled flags; super can
 *              still switch them off per user)
 *   apps     — application-level feature points (opt-in or capability-backed)
 *   advanced — opt-in rollout flags + the individually-assignable tool bucket
 */
type FeaturePointGroup = 'basic' | 'apps' | 'advanced';

export interface FeaturePointDef {
  key: string;
  title: string;
  description: string;
  icon: string; // lucide icon name (web renders it)
  kind: FeaturePointKind;
  group: FeaturePointGroup;
  /** kind 'app': the manifest application this point maps to. */
  appId?: string;
  /** Main toggle lands on this feature flag (memory/tables, or an extension flag). */
  flag?: string;
  /** kind 'app' without a flag: main toggle writes a deny/inherit override on this pattern. */
  capabilityPrefix?: string;
  /** Tools that belong to this point (ride with the feature, not separately assigned). */
  toolIds: readonly string[];
}

/**
 * Ordered feature points, grouped by permission-modal tab: basic (default-on
 * baseline) → apps (application points) → advanced (opt-in flags + the derived
 * tool bucket, see `toolsetToolIds`).
 */
const CORE_FEATURE_POINTS: readonly FeaturePointDef[] = [
  {
    key: 'tools',
    title: 'Advanced tools',
    description: 'Opt-in tools not owned by an application — grant individually.',
    icon: 'Wrench',
    kind: 'toolset',
    group: 'advanced',
    toolIds: [],
  },
];

/** Core points followed by the points of every active extension (see extensions/index.ts). */
export const FEATURE_POINTS: readonly FeaturePointDef[] = [...CORE_FEATURE_POINTS, ...fromExtensions('featurePoints')];

/**
 * The feature flag that gates a platform application, if any.
 *
 * Derived from the registry so the HTTP layer never hard-codes app ids: an app
 * an extension brings is gated by its own flag on exactly the same path.
 */
export function appFeatureFlag(appId: string): string | undefined {
  return FEATURE_POINTS.find((point) => point.kind === 'app' && point.appId === appId)?.flag;
}

/**
 * Tool ids that are NOT individually assignable: they ride with a feature
 * point's main toggle (app or flag). They must stay out of the opt-in "Advanced
 * tools" bucket — a direct assignment for a feature-owned tool would bypass its flag.
 */
export const FEATURE_OWNED_TOOL_IDS = new Set<string>(FEATURE_POINTS.flatMap((p) => p.toolIds));

/**
 * The "Advanced tools" bucket = every non-global tool not owned by a feature
 * point, sorted by the catalog's sort_order. Derived — no hand-maintained list.
 */
export function toolsetToolIds(): string[] {
  return TOOL_DEFINITIONS.filter((m) => !m.is_global && !FEATURE_OWNED_TOOL_IDS.has(m.id) && isInAppTool(m.id))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((m) => m.id);
}

// ─── Access view shape ───────────────────────────────────

export interface AccessCapability {
  capability: string;
  moduleId: string;
  moduleTitle: string;
  /** Distinct action titles that share this capability (for a friendly hint). */
  actions: string[];
  allowed: boolean;
  reason: string;
  matchedPattern?: string;
}

export interface AccessEntityField {
  id: string;
  title: string;
  classification: string;
}

export interface AccessEntity {
  appId: string;
  entityId: string;
  title: string;
  accessScopes: string[];
  fields: AccessEntityField[];
  effectivePolicy: { scopes: string[]; fields: Record<string, FieldPolicy> };
}

export interface AccessTool {
  id: string;
  name: string;
  brief: string;
  category: string;
  icon: string;
  assigned: boolean;
}

export type AccessMainControl = { type: 'flag'; flag: string } | null;

export interface AccessFeaturePoint {
  key: string;
  title: string;
  description: string;
  icon: string;
  kind: FeaturePointKind;
  group: FeaturePointGroup;
  appId?: string;
  enabled: boolean;
  /** How the main toggle is written; null for the toolset bucket. */
  mainControl: AccessMainControl;
  capabilities?: AccessCapability[];
  entities?: AccessEntity[];
  tools?: AccessTool[];
}

export interface UserAccessView {
  user: { id: string; nickname: string; email: string; role: string; status: string };
  featurePoints: AccessFeaturePoint[];
  baseline: {
    globalTools: AccessTool[];
  };
}

// ─── Composition ─────────────────────────────────────────

function toAccessTool(id: string, assigned: boolean): AccessTool | null {
  const meta = getToolMeta(id);
  if (!meta) return null;
  return { id, name: meta.name, brief: meta.brief, category: meta.category, icon: meta.icon, assigned };
}

/**
 * Compose the three authorization mechanisms into one per-user view, organized by
 * feature point. Reuses the same primitives as `/effective` (runtime.authorize,
 * getEntityPolicySnapshot, resolveEntityPolicy) so the two never diverge.
 */
export async function buildUserAccessView(db: DatabaseProvider, user: UserRow): Promise<UserAccessView> {
  const runtime = getPlatformRuntime();
  const actor = humanActor(user);
  const isSuper = user.role === 'super';

  const [featureRows, assignedTools] = await Promise.all([
    db.userFeatures.listByUser(user.id),
    db.userTools.getTools(user.id),
  ]);

  const featureState = new Map(featureRows.map((r) => [r.feature, r.enabled]));
  const resolveFlag = (key: string): boolean =>
    isSuper ? true : featureState.has(key) ? Boolean(featureState.get(key)) : featureDefault(key);
  const assignedSet = new Set(assignedTools);
  const toolAssigned = (id: string) => isSuper || assignedSet.has(id);

  const featurePoints: AccessFeaturePoint[] = [];

  for (const point of FEATURE_POINTS) {
    if (point.kind === 'flag' && point.flag) {
      featurePoints.push({
        key: point.key,
        title: point.title,
        description: point.description,
        icon: point.icon,
        kind: point.kind,
        group: point.group,
        enabled: resolveFlag(point.flag),
        mainControl: { type: 'flag', flag: point.flag },
      });
      continue;
    }

    if (point.kind === 'toolset') {
      const tools = toolsetToolIds()
        .map((id) => toAccessTool(id, toolAssigned(id)))
        .filter((t): t is AccessTool => t !== null);
      featurePoints.push({
        key: point.key,
        title: point.title,
        description: point.description,
        icon: point.icon,
        kind: point.kind,
        group: point.group,
        enabled: tools.some((t) => t.assigned),
        mainControl: null,
        tools,
      });
      continue;
    }

    // kind 'app'
    const manifest = point.appId ? runtime.getManifest(point.appId) : undefined;
    if (!manifest) continue;

    // Capabilities: one row per distinct capability, labeled by module + action titles.
    const capabilities: AccessCapability[] = [];
    const byCapability = new Map<string, string[]>();
    for (const action of Object.values(manifest.actions)) {
      const titles = byCapability.get(action.capability) ?? [];
      titles.push(action.title);
      byCapability.set(action.capability, titles);
    }
    for (const capability of manifest.capabilities) {
      const decision = await runtime.authorize(actor, capability);
      const anyAction = Object.values(manifest.actions).find((a) => a.capability === capability);
      const moduleId = anyAction?.module ?? '';
      capabilities.push({
        capability,
        moduleId,
        moduleTitle: manifest.modules[moduleId]?.title ?? moduleId,
        actions: byCapability.get(capability) ?? [],
        allowed: decision.allowed,
        reason: decision.reason,
        matchedPattern: decision.matchedPattern,
      });
    }

    // Entities: effective record/field policy + explicit override.
    const entities: AccessEntity[] = [];
    for (const entity of Object.values(manifest.entities)) {
      const snapshot = await db.platform.getEntityPolicySnapshot({
        orgId: PLATFORM_ORG_ID,
        userId: user.id,
        appId: manifest.id,
        entityId: entity.id,
      });
      const effective = resolveEntityPolicy(snapshot.rolePolicies);
      entities.push({
        appId: manifest.id,
        entityId: entity.id,
        title: entity.title,
        accessScopes: [...entity.accessScopes],
        fields: Object.entries(entity.fields).map(([id, field]) => ({
          id,
          title: field.title,
          classification: field.classification ?? 'public',
        })),
        effectivePolicy: { scopes: effective.scopes.map((s) => s.kind), fields: effective.fields },
      });
    }

    const enabled = point.flag ? resolveFlag(point.flag) : capabilities.some((c) => c.allowed);
    // App access follows the member's role (per-user overrides were retired in 3.0).
    const mainControl: AccessMainControl = point.flag ? { type: 'flag', flag: point.flag } : null;

    featurePoints.push({
      key: point.key,
      title: point.title,
      description: point.description,
      icon: point.icon,
      kind: point.kind,
      group: point.group,
      appId: manifest.id,
      enabled,
      mainControl,
      capabilities,
      entities,
    });
  }

  // External-only tools (MCP / Agent API) are not part of what the dialog grants in the app.
  const globalTools = getGlobalToolIds()
    .filter(isInAppTool)
    .map((id) => toAccessTool(id, true))
    .filter((t): t is AccessTool => t !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    user: {
      id: user.id,
      nickname: user.nickname,
      email: user.email,
      role: user.role,
      status: user.status,
    },
    featurePoints,
    baseline: {
      globalTools,
    },
  };
}
