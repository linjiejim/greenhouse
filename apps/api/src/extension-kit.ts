/**
 * The import surface for extensions — everything an extension under
 * `apps/api/src/extensions/<id>/` normally needs, re-exported from one place so
 * extension code does not have to know the core folder layout. Deeper imports
 * stay possible; this barrel is a convenience and the documented stable subset.
 */
export { defineExtension, extensionPath } from './extensions/define.js';
export type {
  GreenhouseExtension,
  ExtensionRoute,
  ExtensionApplication,
  ExtensionJob,
  ExtensionCommand,
  ExtensionBootContext,
} from './extensions/define.js';

export { defineTool } from './tools/define.js';
export type { ToolModule, ToolMeta, LazyToolContext, ToolCategory } from './tools/define.js';

export type { AppEnv } from './app-env.js';
export { getAuthUser, requireFeature, requireInternal, requireSuper } from './auth/middleware.js';

export { getDb, getExtensionServices } from '@greenhouse/db';
export type { DatabaseProvider, Db } from '@greenhouse/db';

export { GREENHOUSE_CONFIG, extensionEnabled, resolvePackPath } from './config/greenhouse-config.js';
export { getWorkspaceValue } from './settings/workspace-config.js';

export type { FeaturePointDef } from './platform/feature-points.js';
export type { FeatureFlag } from '@greenhouse/types/features';
export type { WorkspaceSettingDef } from '@greenhouse/types/workspace-settings';
export type { GreenhouseConfig } from '@greenhouse/types/config';

export { logger } from '@greenhouse/utils/logger';
