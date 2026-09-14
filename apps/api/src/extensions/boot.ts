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
import { EXTENSIONS, fromExtensions } from './index.js';
import type { ExtensionCommand, ExtensionJob } from './define.js';

/** Platform applications owned by active extensions, for `initializePlatformRuntime`. */
export function extensionApplicationRegistrations(): ApplicationRegistration<PlatformHandlerContext>[] {
  return fromExtensions('applications').map(({ manifest, handlers }) => ({ manifest, handlers }));
}

/** The same applications as bootstrap plans (manifest + baseline team capabilities). */
export function extensionApplicationPlans(): {
  manifest: ApplicationRegistration['manifest'];
  teamCapabilities: readonly string[];
}[] {
  return fromExtensions('applications').map((app) => ({
    manifest: app.manifest,
    teamCapabilities: app.teamCapabilities ?? [`${app.manifest.id}.*`],
  }));
}

export function extensionMigrationSources(): ExtensionMigrationSource[] {
  return EXTENSIONS.filter((ext) => ext.migrations).map((ext) => ({ extensionId: ext.id, dir: ext.migrations!.dir }));
}

/** Apply pending extension migrations (no-op without active extensions that ship any). */
export async function applyExtensionMigrations(db: DatabaseProvider): Promise<void> {
  const sources = extensionMigrationSources();
  if (sources.length === 0) return;
  const { applied } = await db.extensionMigrations.apply(sources);
  if (applied.length > 0) logger.info(`[Extensions] Applied ${applied.length} migration(s): ${applied.join(', ')}`);
}

/** Mount extension routes after the typed core chain; guards run for every request under the prefix. */
export function mountExtensionRoutes(app: Hono<AppEnv>): void {
  for (const ext of EXTENSIONS) {
    for (const route of ext.routes ?? []) {
      for (const guard of route.guards ?? []) app.use(`${route.path}/*`, guard);
      app.route(route.path, route.app);
      logger.info(`[Extensions] ${ext.id}: mounted ${route.path}`);
    }
  }
}

export async function runExtensionBootHooks(db: DatabaseProvider): Promise<void> {
  for (const ext of EXTENSIONS) {
    if (!ext.onBoot) continue;
    await ext.onBoot({ db, config: GREENHOUSE_CONFIG });
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

/** Skill-pack roots from `greenhouse.config.ts` plus the ones bundled with active extensions. */
export function extensionSkillPackDirs(): string[] {
  return [...GREENHOUSE_CONFIG.packs.skills, ...fromExtensions('skillPacks')];
}
