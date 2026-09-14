/**
 * The extension contract — one object per extension, every field optional and
 * mapped 1:1 onto an existing core registry (see EXTENDING.md → "Extensions").
 *
 * An extension is a folder under `apps/api/src/extensions/<id>/` (plus, for UI,
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
import type { WidgetRecipe } from '@greenhouse/types/workbench';
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

export interface GreenhouseExtension {
  /** Stable id: lowercase letters, digits, dashes. Also the config / env switch. */
  id: string;
  /** Human name shown in admin surfaces. */
  name: string;
  description?: string;

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

  /** Agent tools — auto-exposed to chat, `/api/agent` and `/api/mcp` per each tool's `meta.surface`. */
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
   * `drive_folders` / `drive_files` tables, keyed by `owner_key` and guarded by
   * the resolver declared here. Core validates the shape and delegates the rule.
   */
  driveScopes?: DriveScopeDef[];
  /** Whole-dataset sources offered by `export_data`, beyond core's inline/tables. */
  exportSources?: ExtensionExportSource[];
  /**
   * MCP consent groups this extension owns (conventionally its own id). A token
   * can then be granted `mcp:<group>` alone; tools join it via `surface.mcp`.
   */
  mcpGroups?: string[];
  /** Home-workbench cards this extension offers, backed by its own read tools. */
  workbenchRecipes?: WidgetRecipe[];
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
