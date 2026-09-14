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

/** Identity helper with the one validation worth doing early: a well-formed id. */
export function defineExtension(extension: GreenhouseExtension): GreenhouseExtension {
  if (!ID_PATTERN.test(extension.id)) {
    throw new Error(`Extension id "${extension.id}" must match ${ID_PATTERN} (it is also the config switch)`);
  }
  return extension;
}

/** Resolve a path relative to the calling module: `extensionPath(import.meta.url, 'migrations')`. */
export function extensionPath(importMetaUrl: string, ...segments: string[]): string {
  return resolve(dirname(fileURLToPath(importMetaUrl)), ...segments);
}
