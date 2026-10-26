import { RESERVED_ENTITY_OWNERS } from '@greenhouse/types/entity-links';
/**
 * The extension contract — one object per extension, every field optional and
 * mapped 1:1 onto an existing core registry (see EXTENDING.md → "Extensions").
 *
 * An extension is a configured package under `plugins/<id>/`, or an SDK 1 folder under
 * `apps/api/src/extensions/<id>/` (plus, for UI,
 * `apps/web/src/extensions/<id>/`) that exports `defineExtension({...})` and is
 * listed once in `apps/api/src/extensions/index.ts`. Nothing else in core needs
 * to change — the registries aggregate from that list. Which listed extensions
 * are *active* is decided per deployment by `greenhouse.config.ts` /
 * `GREENHOUSE_EXTENSIONS`.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Hono, MiddlewareHandler } from 'hono';
import type { ApplicationRegistration } from '@greenhouse/platform-kernel';
import type { DatabaseProvider, Db } from '@greenhouse/db';
import type { FeatureFlag } from '@greenhouse/types/features';
import type { ExtensionEntityKindDef } from '@greenhouse/types/entity-links';
import type { SearchSource } from '../search/sources.js';
import type { DriveScopeDef } from '../drive/access.js';
import type { ExtensionExportSource } from '../tools/export-sources.js';
import type { WorkspaceSettingDef } from '@greenhouse/types/workspace-settings';
import type { GreenhouseConfig } from '@greenhouse/types/config';
import type { AppEnv } from '../app-env.js';
import type { ToolModule } from '../tools/define.js';
import type { PlatformHandlerContext } from '../platform/runtime.js';
import type { FeaturePointDef } from '../platform/feature-points.js';

export interface ExtensionRoute {
  /** Mount prefix. Convention: `/api/ext/<extension id>`; any prefix not used by core is accepted. */
  path: string;
  /** A `new Hono<AppEnv>()` with the extension's handlers. */
  app: Hono<AppEnv>;
  /** Guards applied to every request under `path` — e.g. `requireFeature('crm')`, `requireInternal()`. */
  guards?: MiddlewareHandler<AppEnv>[];
}

/** A platform application (manifest + handlers) owned by the extension. */
export interface ExtensionApplication extends ApplicationRegistration<PlatformHandlerContext> {
  /** Capabilities granted to the `team` role at bootstrap, e.g. `['crm.*']`. */
  teamCapabilities?: readonly string[];
  /** Entities the `team` role may export in full (default: none). */
  teamExportableEntities?: readonly string[];
  /**
   * Tools backed by this application's actions, so MCP hides a tool whose every
   * action is denied — the same rule core applies to its own registry tools.
   */
  platformTools?: { query?: readonly string[]; command?: readonly string[] };
}

export interface ExtensionJob {
  id: string;
  /** Cron expression (croner syntax). */
  cron: string;
  /** IANA zone; defaults to the scheduler's zone (`SCHEDULER_TIMEZONE`, UTC). */
  timezone?: string;
  run: () => Promise<void> | void;
}

export interface ExtensionCommand {
  /** `pnpm cli <name> …`. Namespace it with the extension id, e.g. `crm:import`. */
  name: string;
  /** One-line usage shown by `pnpm cli --help`. */
  usage: string;
  run: (args: string[]) => Promise<number>;
}

export interface ExtensionBootContext {
  db: DatabaseProvider;
  config: GreenhouseConfig;
}

export interface ExtensionPromptContext {
  toolIds: readonly string[];
  build: (userId: string, role?: string) => Promise<string | null>;
}

export interface ExtensionActivity {
  writeLabels?: Record<string, (db: DatabaseProvider, userId: string, input: unknown) => Promise<string | null>>;
  writeRisks?: Record<string, (input: unknown) => 'r1' | 'r2' | 'r3' | null>;
  auditShape?: (
    row: import('@greenhouse/db').ActivityAuditRow,
    summary: Record<string, unknown>,
  ) => import('../activity/activity-log.js').WriteShape | null;
  auditCapabilities?: string[];
  actionEntities?: Record<string, string>;
  auditShapes?: Record<string, import('../activity/activity-log.js').WriteShape>;
  toolShapes?: Record<string, Record<string, import('../activity/activity-log.js').WriteShape>>;
  toolTargets?: Record<
    string,
    (
      ctx: import('../activity/activity-log.js').HydrateContext,
      row: import('@greenhouse/db').ActivityRunRow,
      action: string | null,
      shape: import('../activity/activity-log.js').WriteShape,
    ) => Promise<import('@greenhouse/types/activity').ActivityItem['target']>
  >;
  /** Tool write descriptions and audit actions owned by this plugin. */
  appModules?: Record<string, string>;
  toolModules?: Record<string, string>;
  fileTools?: string[];
  personActions?: Array<{ appId: string; module: string; actionIds: readonly string[] }>;
  toolWrites?: Record<string, { entity: string; verb?: string; title?: { result: string; field: string } }>;
  adminActions?: Record<string, string[]>;
  targets?: Record<
    string,
    (
      ctx: import('../activity/activity-log.js').HydrateContext,
      row: import('@greenhouse/db').ActivityAuditRow,
      summary: Record<string, unknown>,
    ) => Promise<{ label: string; url: string | null } | null>
  >;
}

export interface GreenhouseExtension {
  /** Stable id: lowercase letters, digits, dashes. Also the config / env switch. */
  id: string;
  /** Human name shown in admin surfaces. */
  name: string;
  description?: string;
  version?: string;

  /**
   * The extension contract revision this was written for (`EXTENSION_SDK` from
   * the kit). A mismatch refuses activation. Optional in 3.x (warns), required from 4.0.
   */
  sdk?: number;
  /**
   * Greenhouse versions this extension supports, as a semver range, e.g.
   * `'>=3.0 <4'`. A pre-release counts as its release. Checked against the
   * running version (`APP_VERSION`, else the root package.json) at activation.
   */
  core?: string;

  /**
   * Other extensions this one needs, by id.
   *
   * Two extensions in the same build can import each other's exports by
   * relative path — they are ordinary modules. What they cannot do is check at
   * runtime that the other one is actually switched on, which is a
   * configuration mistake that otherwise surfaces as a confusing failure deep
   * in a request. Declaring it here turns that into a clear error at boot, and
   * documents the coupling where a reader will find it.
   *
   * Depend on another extension only for something genuinely unshareable — an
   * authenticated transport, a credential chain. Anything else belongs in core.
   */
  dependsOn?: string[];

  teamContextSources?: import('../hub-context/settings.js').TeamContextDocumentSource[];
  workspaceTimeZoneChanged?: Array<() => Promise<void>>;
  schedules?: Array<{ nextRun: () => Date | null }>;
  mcpResources?: import('./mcp-resources.js').ExtensionMcpResources[];
  discriminators?: import('@greenhouse/types/discriminators').DiscriminatorValues;
  notificationTransports?: import('../notifications/transports.js').NotificationTransport[];
  notificationKinds?: string[];
  identityProviders?: import('../auth/identity-providers.js').IdentityProvider[];
  channels?: import('./channels.js').AgentChannel[];
  /** Infrastructure env names which have no effect unless this plugin is active. */
  configurationEnv?: string[];
  rateLimits?: import('../security/extension-rate-limits.js').ExtensionRateLimit[];
  /** Tools the owner may explicitly grant to unattended automations. */
  automationTools?: import('@greenhouse/types/automation-tools').AutomationOptInTool[];
  /** Stored profile tool ids retired into this plugin's current tool ids. */
  retiredToolAliases?: Record<string, readonly string[]>;
  /** MCP group descriptions and hints, cut to the caller's reachable tools. */
  hubContext?: Array<{
    group: string;
    description: string;
    toolIds: string[];
    overviewHint?: string;
    bundleHint?: string;
  }>;
  /** Stable system-prompt context, scoped to tools reachable by this member. */
  promptContext?: ExtensionPromptContext[];
  /** Stable prompt fragments and permission-filtered MCP resources/prompts. */
  agentContext?: import('./agent-context.js').ExtensionAgentContext;
  /** Paid service definitions, including optional runtime availability checks. */
  billableServices?: import('../config/service-registry.js').BillableService[];
  /** Per-request availability reasons for tool listings and admission. */
  toolAvailability?: Array<(toolId: string) => Promise<string | null>>;
  /** Bounded daily retention for plugin-owned tables. */
  retention?: import('@greenhouse/db').ExtensionRetentionRule[];
  activity?: ExtensionActivity[];
  catalogSources?: Array<{
    id: string;
    /** Owns the complete catalogue presentation instead of the automatic tool-source entry. */
    replaceDefaultSource?: boolean;
    load: (
      input: import('../hub-context/catalog.js').CatalogInput,
    ) => Promise<Partial<Pick<import('@greenhouse/types/hub-context').DataCatalog, 'bases' | 'truncated'>>>;
  }>;
  recentChanges?: import('../activity/recent-source.js').RecentChangeSource[];
  objectRefs?: import('../routes/refs.js').ObjectRefSource[];
  settingValueValidators?: Array<
    (key: string, value: unknown) => import('../settings/workspace-config.js').ValidationResult | null
  >;
  settingValidators?: Array<(key: string, value: string) => string | null>;
  /** Optional data sources consumed by system summaries. */
  summarySources?: Array<{
    id: string;
    load: (
      db: DatabaseProvider,
      window: { from: string; to: string },
    ) => Promise<Partial<import('../usage/summary.js').RetroAggregates>>;
  }>;
  /** Agent tools — auto-exposed to chat, `/api/agent` and `/api/mcp` per each tool's `meta.surface`. */
  toolResults?: import('@greenhouse/agent-core').ToolResultAdapter[];
  tools?: ToolModule[];
  /** HTTP routes mounted after the core chain. */
  routes?: ExtensionRoute[];
  /** Platform applications (manifest v2) — permissions, entity policies, navigation. */
  applications?: ExtensionApplication[];
  /** Per-user feature flags (stored in `user_features`, toggled in the permissions dialog). */
  featureFlags?: FeatureFlag[];
  /** Feature points: what a flag / app owns (tools, capability prefix) — one switch for app + REST + MCP + chat. */
  featurePoints?: FeaturePointDef[];
  /** Admin-editable runtime settings (`<id>.<name>`, group `<id>`), rendered in Runtime Config. */
  workspaceSettings?: WorkspaceSettingDef[];
  /**
   * Record kinds this extension owns (`ext:<id>:<name>` + a hash route with one
   * `:id`), so its records get deeplinks in tool output and peeks in chat.
   * The web half registers the icon and the peek body for the same kind.
   */
  entityKinds?: ExtensionEntityKindDef[];
  /** Lanes added to the global search palette, one per record kind. */
  searchSources?: SearchSource[];
  /**
   * Drive scopes this extension owns — its own file cabinet inside the shared
   * `folders` / `files` tables, keyed by `owner_key` and guarded by
   * the resolver declared here. Core validates the shape and delegates the rule.
   */
  driveScopes?: DriveScopeDef[];
  /** Whole-dataset sources offered by `export_data`, beyond core's inline rows. */
  exportSources?: ExtensionExportSource[];
  /**
   * MCP consent groups this extension owns (conventionally its own id). A token
   * can then be granted `mcp:<group>` alone; tools join it via `surface.mcp`.
   */
  mcpGroups?: string[];
  /** @deprecated Ignored since 3.0 (the Home workbench was removed); kept so 2.x extensions compile. Removed in 4.0. */
  workbenchRecipes?: unknown[];
  /** Paths that skip authentication (OAuth callbacks, webhooks). Keep this list minimal. */
  publicPaths?: { exact?: string[]; prefixes?: string[] };
  /** Periodic jobs started with the scheduler. */
  jobs?: ExtensionJob[];
  /** `pnpm cli` commands. */
  commands?: ExtensionCommand[];
  /** Directory of ordered `*.sql` files applied at boot in the extension migration lane. */
  migrations?: { dir: string };
  /** Service factory, exposed as `db.extensions[<id>]`. */
  services?: (db: Db) => Record<string, unknown>;
  /** Tables to truncate with the core tables between integration tests / `pnpm cli db reset`. */
  resetTables?: string[];
  /** Example datasets, loaded after core seed rows in dependency order. */
  seeds?: Array<{ dir: string; tables: string[] }>;
  /** Skill-pack roots bundled with the extension (same layout as `skillhub/`). */
  skillPacks?: string[];
  /** Runs after the database, platform runtime and tool registry are ready, before routes are served. */
  onBoot?: (ctx: ExtensionBootContext) => Promise<void> | void;
  onShutdown?: () => Promise<void> | void;
}

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Identity helper with the validations worth doing early: a well-formed id, and
 * tools core can actually build. Core wires its own lazy tools by name; an
 * extension tool has exactly one path each — `create` for static, `createLazy`
 * for lazy — and without it the tool sits in the catalog but is never handed to
 * the agent, which only shows up at run time as "I have no such tool".
 */
export function defineExtension(extension: GreenhouseExtension): GreenhouseExtension {
  if (!ID_PATTERN.test(extension.id)) {
    throw new Error(`Extension id "${extension.id}" must match ${ID_PATTERN} (it is also the config switch)`);
  }
  for (const kind of extension.entityKinds ?? []) {
    const owner = RESERVED_ENTITY_OWNERS[kind.kind];
    if (owner && owner !== extension.id)
      throw new Error(`Entity kind "${kind.kind}" is reserved for its official plugin`);
  }
  for (const kind of extension.notificationKinds ?? []) {
    if (!kind.startsWith(`ext:${extension.id}:`))
      throw new Error(`Notification kind must use ext:${extension.id}: namespace: ${kind}`);
  }
  for (const mod of extension.tools ?? []) {
    if (mod.kind === 'static' && !mod.create)
      throw new Error(`Extension "${extension.id}" tool "${mod.meta.id}" is static but has no create()`);
    if (mod.kind === 'lazy' && !mod.createLazy)
      throw new Error(
        `Extension "${extension.id}" tool "${mod.meta.id}" is lazy but has no createLazy() — ` +
          'core has no per-tool case for extension tools, so it could never be built',
      );
  }
  return extension;
}

/** Resolve a path relative to the calling module: `extensionPath(import.meta.url, 'migrations')`. */
export function extensionPath(importMetaUrl: string, ...segments: string[]): string {
  return resolve(dirname(fileURLToPath(importMetaUrl)), ...segments);
}
