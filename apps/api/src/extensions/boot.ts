import { serveStatic } from '@hono/node-server/serve-static';
import { createIdentityProviderRoutes } from '../auth/identity-providers.js';
/**
 * Boot-time glue between the active extensions and the core runtime: what
 * `apps/api/src/index.ts`, the scheduler and the CLI call to fold extension
 * contributions into the places that cannot import the extension list at
 * module scope (route mounting, migrations, hooks, jobs, commands).
 */
import type { Hono } from 'hono';
import type { DatabaseProvider, ExtensionMigrationSource } from '@greenhouse/db';
import type { ApplicationRegistration } from '@greenhouse/platform-kernel';
import { logger } from '@greenhouse/utils/logger';
import type { AppEnv } from '../app-env.js';
import type { PlatformHandlerContext } from '../platform/runtime.js';
import { GREENHOUSE_CONFIG } from '../config/greenhouse-config.js';
import { COMPILED_EXTENSIONS, EXTENSIONS, fromExtensions } from './index.js';
import { recordExtensionBootReady, recordExtensionBootError } from './health.js';
import type { ExtensionCommand, ExtensionJob } from './define.js';

/** Platform applications owned by active extensions, for `initializePlatformRuntime`. */
export function extensionApplicationRegistrations(): ApplicationRegistration<PlatformHandlerContext>[] {
  return fromExtensions('applications').map(({ manifest, handlers }) => ({ manifest, handlers }));
}

/**
 * Tool → capability map for applications extensions own, in the shape
 * `routes/mcp.ts` folds into its own: a tool is hidden once every capability
 * behind it is denied.
 */
export function extensionPlatformToolCapabilities(
  capabilitiesByActionKind: (manifest: ApplicationRegistration['manifest'], kind: 'query' | 'command') => string[],
): Record<string, readonly string[]> {
  const map: Record<string, readonly string[]> = {};
  for (const app of fromExtensions('applications')) {
    for (const kind of ['query', 'command'] as const) {
      for (const toolId of app.platformTools?.[kind] ?? []) {
        map[toolId] = capabilitiesByActionKind(app.manifest, kind);
      }
    }
  }
  return map;
}

/** The same applications as bootstrap plans (manifest + baseline team capabilities). */
export function extensionApplicationPlans(): {
  manifest: ApplicationRegistration['manifest'];
  teamCapabilities: readonly string[];
  teamExportableEntities?: readonly string[];
  teamFieldPolicies?: import('./define.js').ExtensionApplication['teamFieldPolicies'];
}[] {
  return fromExtensions('applications').map((app) => ({
    manifest: app.manifest,
    teamCapabilities: app.teamCapabilities ?? [`${app.manifest.id}.*`],
    teamExportableEntities: app.teamExportableEntities,
    teamFieldPolicies: app.teamFieldPolicies,
  }));
}

export function extensionMigrationSources(): ExtensionMigrationSource[] {
  return EXTENSIONS.filter((ext) => ext.migrations).map((ext) => ({ extensionId: ext.id, dir: ext.migrations!.dir }));
}

/**
 * Apply pending extension migrations (no-op without active extensions that ship
 * any). `pnpm db:migrate` already ran the lane in a normal deploy; this is the
 * idempotent second pass. 1x files are never run — recorded and logged as skipped.
 */
export async function applyExtensionMigrations(db: DatabaseProvider): Promise<void> {
  const sources = extensionMigrationSources();
  if (sources.length === 0) return;
  let result;
  try {
    result = await db.extensionMigrations.apply(sources);
  } catch (error) {
    for (const source of sources) recordExtensionBootError(source.extensionId, error);
    throw error;
  }
  const { applied, skipped } = result;
  if (applied.length > 0) logger.info(`[Extensions] Applied ${applied.length} migration(s): ${applied.join(', ')}`);
  if (skipped.length > 0) {
    logger.info(`[Extensions] Skipped ${skipped.length} 1.x-generation migration(s): ${skipped.join(', ')}`);
  }
}

/** Mount extension routes after the typed core chain; guards run for every request under the prefix. */
export function mountExtensionRoutes(app: Hono<AppEnv>): void {
  for (const provider of fromExtensions('identityProviders'))
    app.route(provider.path, createIdentityProviderRoutes(provider));
  for (const ext of EXTENSIONS) {
    if (ext.ui) {
      app.use(
        `/ext/${ext.id}/ui/*`,
        async (c, next) => {
          c.set('extensionUi', true);
          await next();
        },
        serveStatic({ root: ext.ui.dir, rewriteRequestPath: (path) => path.slice(`/ext/${ext.id}/ui`.length) }),
      );
    }
    for (const route of ext.routes ?? []) {
      for (const guard of route.guards ?? []) {
        app.use(route.path, guard);
        app.use(`${route.path}/*`, guard);
      }
      app.route(route.path, route.app);
      logger.info(`[Extensions] ${ext.id}: mounted ${route.path}`);
    }
  }
}

export async function runExtensionBootHooks(db: DatabaseProvider): Promise<void> {
  for (const ext of COMPILED_EXTENSIONS) {
    if (!EXTENSIONS.includes(ext) && ext.configurationEnv?.some((key) => !!process.env[key]))
      logger.info(`[Extensions] ${ext.id}: environment configured; enable plugin ${ext.id} to use it`);
  }
  for (const ext of EXTENSIONS) {
    try {
      if (ext.onInstall)
        await db.extensionMigrations.installOnce(ext.id, async () => {
          await ext.onInstall!({ db, config: GREENHOUSE_CONFIG });
        });
      await ext.onBoot?.({ db, config: GREENHOUSE_CONFIG });
      recordExtensionBootReady(ext.id);
    } catch (error) {
      recordExtensionBootError(ext.id, error);
      throw error;
    }
  }
  if (EXTENSIONS.length > 0) logger.info(`[Extensions] Active: ${EXTENSIONS.map((e) => e.id).join(', ')}`);
}

export async function runExtensionShutdownHooks(): Promise<void> {
  for (const ext of EXTENSIONS) {
    try {
      await ext.onShutdown?.();
    } catch (err) {
      logger.warn(`[Extensions] ${ext.id}: shutdown hook failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function extensionJobs(): ExtensionJob[] {
  return fromExtensions('jobs');
}

export function extensionCommands(): ExtensionCommand[] {
  return fromExtensions('commands');
}

export { extensionSkillPackDirs } from './skill-packs.js';
