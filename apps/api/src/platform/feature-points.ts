/**
 * Feature-point registry + per-user access view (BFF/mapping layer).
 *
 * A "feature point" is the unit of "can this user use capability X", organized the
 * way an admin thinks (Knowledge / Projects / Tables / Memory / …) rather than by the
 * three underlying mechanisms it may land on:
 *
 *   • feature flag        (user_features)        — rollout gate      (memory, tables, cloud-agent)
 *   • platform capability (platform_* overrides) — action authz      (knowledge.*, projects.*)
 *   • tool grant          (user_tools)           — chat/proxy tool   (admin opt-in tools)
 *
 * This registry is the SINGLE server-authoritative map. `buildUserAccessView`
 * composes the three mechanisms into one ready-to-render shape consumed by the
 * unified permission modal (Settings → Users → Permissions). Writes still go to
 * the existing granular endpoints — this module is read-only aggregation.
 */

import { resolveEntityPolicy, type FieldPolicy, type UserEntityPolicyOverride } from '@greenhouse/platform-kernel';
import { featureDefault, type FeatureKey } from '@greenhouse/types/features';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { getPlatformRuntime, PLATFORM_ORG_ID } from './runtime.js';
import { humanActor } from './actor.js';
import { TOOL_DEFINITIONS, getToolMeta, getGlobalToolIds } from '../tools/registry.js';

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

interface FeaturePointDef {
  key: string;
  title: string;
  description: string;
  icon: string; // lucide icon name (web renders it)
  kind: FeaturePointKind;
  group: FeaturePointGroup;
  /** kind 'app': the manifest application this point maps to. */
  appId?: string;
  /** Main toggle lands on this feature flag (memory/tables/cloud-agent). */
  flag?: FeatureKey;
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
export const FEATURE_POINTS: readonly FeaturePointDef[] = [
  {
    key: 'tables',
    title: 'Tables',
    description:
      'Internal multidimensional tables. Enabling this turns Tables on everywhere — app, REST, MCP, and chat.',
    icon: 'Table2',
    kind: 'app',
    group: 'basic',
    appId: 'tables',
    flag: 'tables',
    // tables_schema_plan rides the flag but declares no proxy/MCP surface —
    // schema editing is chat-only, where a human can press Confirm (spec D3).
    toolIds: ['tables_query', 'tables_mutation', 'tables_schema_plan'],
  },
  {
    key: 'cloud-agent',
    title: 'Missions',
    description:
      'Long-running missions in disposable sandboxes, including the Missions page and the mission_dispatch chat tool.',
    icon: 'Cloud',
    kind: 'flag',
    group: 'basic',
    flag: 'cloud-agent',
    toolIds: ['mission_dispatch'],
  },
  {
    key: 'memory',
    title: 'AI Memory',
    description: 'The agent learns and remembers this user’s preferences across sessions.',
    icon: 'Brain',
    kind: 'flag',
    group: 'basic',
    flag: 'memory',
    toolIds: ['memory'],
  },
  {
    key: 'knowledge',
    title: 'Knowledge',
    description: 'Team and personal knowledge base, retrieval, and editing.',
    icon: 'BookOpen',
    kind: 'app',
    group: 'apps',
    appId: 'knowledge',
    capabilityPrefix: 'knowledge.*',
    toolIds: ['knowledge_query', 'knowledge_mutation'],
  },
  {
    key: 'projects',
    title: 'Projects',
    description: 'Project and task management.',
    icon: 'ClipboardList',
    kind: 'app',
    group: 'apps',
    appId: 'projects',
    capabilityPrefix: 'projects.*',
    toolIds: ['project_query', 'project_mutation'],
  },
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

/**
 * Per-feature tool id sets, DERIVED from the FEATURE_POINTS entries above — the
 * registry is the single source for "which tools ride which flag". A second
 * hand-written list here is exactly how tables_schema_plan once fell into the
 * assignable bucket (constant said it rode the flag, registry entry didn't).
 */
function pointToolIds(key: string): readonly string[] {
  const point = FEATURE_POINTS.find((p) => p.key === key);
  if (!point) throw new Error(`FEATURE_POINTS entry "${key}" is missing`);
  return point.toolIds;
}

export const TABLES_FEATURE_TOOL_IDS: readonly string[] = pointToolIds('tables');
export const MEMORY_FEATURE_TOOL_IDS: readonly string[] = pointToolIds('memory');
export const CLOUD_AGENT_FEATURE_TOOL_IDS: readonly string[] = pointToolIds('cloud-agent');

/** Workflow tool ids — temporarily visible and executable by super users only. */
export const WORKFLOWS_SUPER_ONLY_TOOL_IDS: readonly string[] = ['workflow_plan'];

/**
 * Tool ids that are NOT individually assignable: they either ride with a feature
 * point's main toggle (app or flag) or have a separate role gate.
 *
 * Both cases must stay out of the opt-in "Advanced tools" bucket. A direct
 * assignment for a feature-owned tool would bypass its flag; a toggle for an
 * role-gated tool would be a no-op that lies to the admin about what it does.
 */
export const FEATURE_OWNED_TOOL_IDS = new Set<string>([
  ...FEATURE_POINTS.flatMap((p) => p.toolIds),
  ...WORKFLOWS_SUPER_ONLY_TOOL_IDS,
]);

/**
 * The "Advanced tools" bucket = every non-global tool not owned by a feature
 * point, sorted by the catalog's sort_order. Derived — no hand-maintained list.
 */
export function toolsetToolIds(): string[] {
  return TOOL_DEFINITIONS.filter((m) => !m.is_global && !FEATURE_OWNED_TOOL_IDS.has(m.id))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((m) => m.id);
}

// ─── Access view shape ───────────────────────────────────

export type CapabilityOverrideMode = 'inherit' | 'allow' | 'deny';

export interface AccessCapability {
  capability: string;
  moduleId: string;
  moduleTitle: string;
  /** Distinct action titles that share this capability (for a friendly hint). */
  actions: string[];
  allowed: boolean;
  reason: string;
  matchedPattern?: string;
  override: CapabilityOverrideMode;
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
  override?: UserEntityPolicyOverride;
}

export interface AccessTool {
  id: string;
  name: string;
  brief: string;
  category: string;
  icon: string;
  assigned: boolean;
}

export type AccessMainControl = { type: 'flag'; flag: FeatureKey } | { type: 'capability'; capability: string } | null;

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
  limits: { monthly_token_limit: number };
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

  const [featureRows, assignedTools, overrides] = await Promise.all([
    db.userFeatures.listByUser(user.id),
    db.userTools.getTools(user.id),
    db.platform.listUserCapabilityOverrides(PLATFORM_ORG_ID, user.id),
  ]);

  const featureState = new Map(featureRows.map((r) => [r.feature, r.enabled]));
  const resolveFlag = (key: FeatureKey): boolean =>
    isSuper ? true : featureState.has(key) ? Boolean(featureState.get(key)) : featureDefault(key);
  const assignedSet = new Set(assignedTools);
  const overrideMap = new Map(overrides.map((o) => [o.capability, o.effect]));
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
        override: (overrideMap.get(capability) as CapabilityOverrideMode) ?? 'inherit',
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
      const effective = resolveEntityPolicy(snapshot.rolePolicies, snapshot.userOverride);
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
        override: snapshot.userOverride,
      });
    }

    const enabled = point.flag ? resolveFlag(point.flag) : capabilities.some((c) => c.allowed);
    const mainControl: AccessMainControl = point.flag
      ? { type: 'flag', flag: point.flag }
      : point.capabilityPrefix
        ? { type: 'capability', capability: point.capabilityPrefix }
        : null;

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

  const globalTools = getGlobalToolIds()
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
    limits: {
      monthly_token_limit: user.monthly_token_limit,
    },
    featurePoints,
    baseline: {
      globalTools,
    },
  };
}
