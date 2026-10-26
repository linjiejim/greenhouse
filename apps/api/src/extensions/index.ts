import { registerDiscriminators } from '@greenhouse/types/discriminators';
import { registerSkillPacks } from './skill-packs.js';
import { registerExtensionRateLimits } from '../security/extension-rate-limits.js';
import { registerAgentContexts } from './agent-context.js';
import { registerUnattendedDeniedTools } from '../agent-runtime/tool-policy.js';
import { registerNotificationTransports } from '../notifications/transports.js';
import { registerIdentityProviders } from '../auth/identity-providers.js';
import { registerNotificationKinds, registerNotificationChannels } from '@greenhouse/types/notification';
import { setExtensionAutomationTools } from '@greenhouse/types/automation-tools';
import { SERVICE_PROVIDERS } from '../config/services.js';
import { registerPromptContexts } from './prompt-context.js';
import { registerWorkspaceSettingValidators } from '../settings/validation-registry.js';
/**
 * Compiled-in extensions.
 *
 * Packages come from greenhouse.config.ts → plugins, assembled by plugins:sync.
 * SDK 1 overlays may still add an import and an IN_TREE list entry here.
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
import { registerExtensionResetTables, registerExtensionServices } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { extensionEnabled } from '../config/greenhouse-config.js';
import { checkExtensionCompat, runningAppVersion } from './compat.js';
import { registerPublicPaths } from '../auth/public-paths.js';
import { registerSearchSources } from '../search/sources.js';
import { registerDriveScopes } from '../drive/access.js';
import { registerExportSources } from '../tools/export-sources.js';
import type { GreenhouseExtension } from './define.js';
import { registerBillableServices } from '../config/service-registry.js';
import { registerExtensionRetention } from '@greenhouse/db';
import { COMPILED_PLUGINS } from './compiled.generated.js';

/** SDK 1 overlay registrations: one import and one entry per in-tree extension. */
const IN_TREE: readonly GreenhouseExtension[] = [];

/** Everything compiled into this build. Order = registration order. */
export const COMPILED_EXTENSIONS: readonly GreenhouseExtension[] = [...COMPILED_PLUGINS, ...IN_TREE];

function activate(compiled: readonly GreenhouseExtension[]): readonly GreenhouseExtension[] {
  const seen = new Set<string>();
  for (const ext of compiled) {
    if (seen.has(ext.id))
      throw new Error(`Extension id "${ext.id}" is listed twice in apps/api/src/extensions/index.ts`);
    seen.add(ext.id);
  }
  const active = compiled.filter((ext) => extensionEnabled(ext.id));
  // Compatibility: a contract or core version the extension was not written for refuses here.
  const version = active.length > 0 ? runningAppVersion() : null;
  for (const ext of active) {
    const { errors, warnings } = checkExtensionCompat(ext, version);
    if (errors.length > 0) throw new Error(errors.join('\n'));
    for (const warning of warnings) logger.warn(`[Extensions] ${warning}`);
  }
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
): NonNullable<GreenhouseExtension[K]> extends readonly (infer T)[] ? T[] : NonNullable<GreenhouseExtension[K]>[] {
  const out: unknown[] = [];
  for (const ext of EXTENSIONS) {
    const value = ext[field];
    if (Array.isArray(value)) out.push(...value);
    else if (value && typeof value === 'object') out.push(value);
  }
  return out as never;
}

// Registries that live in shared packages cannot import this module, so the
// active extensions register into them here, once, at load time.
for (const ext of EXTENSIONS) {
  if (ext.discriminators) registerDiscriminators(ext.discriminators);
  registerDiscriminators({
    auditApps: [
      ext.id,
      ...(ext.applications ?? []).map((a) => a.manifest.id),
      ...Object.keys(Object.assign({}, ...(ext.activity ?? []).map((a) => a.appModules ?? {}))),
    ],
  });
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
}

registerBillableServices(fromExtensions('billableServices'), Object.keys(SERVICE_PROVIDERS));
registerExtensionRetention(fromExtensions('retention'));

registerWorkspaceSettingValidators(fromExtensions('settingValidators'));

registerPromptContexts(fromExtensions('promptContext'));

setExtensionAutomationTools(fromExtensions('automationTools'));

registerNotificationTransports(fromExtensions('notificationTransports'));
registerNotificationKinds(fromExtensions('notificationKinds'));
registerNotificationChannels(fromExtensions('notificationTransports').map((t) => t.id));
registerIdentityProviders(fromExtensions('identityProviders'));

registerUnattendedDeniedTools(
  fromExtensions('tools')
    .filter((t) => t.meta.surface?.unattendedDenied)
    .map((t) => t.meta.id),
);

registerAgentContexts(
  fromExtensions('agentContext').map((context) => {
    const owner = EXTENSIONS.find((ext) => ext.agentContext === context)!;
    return { id: owner.id, context, toolIds: (owner.tools ?? []).map((tool) => tool.meta.id) };
  }),
);

registerExtensionRateLimits(fromExtensions('rateLimits'));

registerSkillPacks(fromExtensions('skillPacks'));

// The remaining core application registers through the same path until its package move.
registerDiscriminators({
  shareResources: ['kb_document'],
  fileLinkTargets: ['kb_document'],
  folderScopes: ['kb'],
  auditApps: ['knowledge'],
});
