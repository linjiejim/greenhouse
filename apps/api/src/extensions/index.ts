/**
 * Compiled-in extensions.
 *
 * Add your extension here — one import, one list entry. Upstream ships only the
 * `example` extension (off by default); a fork keeps its private extensions in
 * this file and in `apps/api/src/extensions/<id>/`, and nowhere else in core.
 *
 * `EXTENSIONS` is the *active* subset: `greenhouse.config.ts` → `extensions.enabled`
 * (or the `GREENHOUSE_EXTENSIONS` env var) decides per deployment. Every core
 * registry aggregates from `EXTENSIONS`, so a disabled extension contributes
 * nothing — no tools, routes, flags, jobs or migrations.
 */
import { registerFeatureFlags } from '@greenhouse/types/features';
import { registerWorkspaceSettings } from '@greenhouse/types/workspace-settings';
import { registerEntityKinds } from '@greenhouse/types/entity-links';
import { registerMcpResourceGroups } from '@greenhouse/types/mcp';
import { registerWidgetRecipes } from '@greenhouse/types/workbench';
import { registerExtensionResetTables, registerExtensionServices } from '@greenhouse/db';
import { extensionEnabled } from '../config/greenhouse-config.js';
import { registerPublicPaths } from '../auth/public-paths.js';
import { registerSearchSources } from '../search/sources.js';
import { registerDriveScopes } from '../drive/access.js';
import { registerExportSources } from '../tools/export-sources.js';
import type { GreenhouseExtension } from './define.js';
import { exampleExtension } from './example/index.js';

/** Everything compiled into this build. Order = registration order. */
export const COMPILED_EXTENSIONS: readonly GreenhouseExtension[] = [exampleExtension];

function activate(compiled: readonly GreenhouseExtension[]): readonly GreenhouseExtension[] {
  const seen = new Set<string>();
  for (const ext of compiled) {
    if (seen.has(ext.id))
      throw new Error(`Extension id "${ext.id}" is listed twice in apps/api/src/extensions/index.ts`);
    seen.add(ext.id);
  }
  const active = compiled.filter((ext) => extensionEnabled(ext.id));
  // A declared dependency that is switched off is a configuration mistake, and
  // one that otherwise surfaces as a confusing failure deep inside a request.
  const activeIds = new Set(active.map((ext) => ext.id));
  for (const ext of active) {
    for (const id of ext.dependsOn ?? []) {
      if (activeIds.has(id)) continue;
      throw new Error(
        `Extension "${ext.id}" depends on "${id}", which is not active — ` +
          'enable it in greenhouse.config.ts (or GREENHOUSE_EXTENSIONS) alongside it.',
      );
    }
  }
  return active;
}

/** The active extensions of this deployment. */
export const EXTENSIONS: readonly GreenhouseExtension[] = activate(COMPILED_EXTENSIONS);

/** Concatenate one optional list field across the active extensions. */
export function fromExtensions<K extends keyof GreenhouseExtension>(
  field: K,
): NonNullable<GreenhouseExtension[K]> extends readonly (infer T)[] ? T[] : never {
  const out: unknown[] = [];
  for (const ext of EXTENSIONS) {
    const value = ext[field];
    if (Array.isArray(value)) out.push(...value);
  }
  return out as never;
}

// Registries that live in shared packages cannot import this module, so the
// active extensions register into them here, once, at load time.
for (const ext of EXTENSIONS) {
  if (ext.featureFlags?.length) registerFeatureFlags(ext.featureFlags);
  if (ext.workspaceSettings?.length) registerWorkspaceSettings(ext.workspaceSettings);
  if (ext.services) registerExtensionServices(ext.id, ext.services);
  if (ext.resetTables?.length) registerExtensionResetTables(ext.resetTables);
  if (ext.publicPaths) registerPublicPaths(ext.publicPaths);
  if (ext.mcpGroups?.length) registerMcpResourceGroups(ext.mcpGroups);
  if (ext.entityKinds?.length) registerEntityKinds(ext.entityKinds);
  if (ext.searchSources?.length) registerSearchSources(ext.searchSources);
  if (ext.driveScopes?.length) registerDriveScopes(ext.driveScopes);
  if (ext.exportSources?.length) registerExportSources(ext.exportSources);
  if (ext.workbenchRecipes?.length) registerWidgetRecipes(ext.workbenchRecipes);
}
