/**
 * The import surface for extensions — everything an extension under
 * `apps/api/src/extensions/<id>/` may use from core, re-exported from one place
 * so extension code does not depend on the core folder layout.
 *
 * This barrel IS the stable API (with the define types, `@greenhouse/types` and
 * `@greenhouse/crud`); everything else in core is internal and may change in
 * any release. `scripts/check-extension-overlay.mjs` reports extension files
 * that import past it. The export list is locked by
 * `__tests__/extension-kit.snapshot.test.ts`: removing or renaming a symbol
 * means updating the snapshot and a CHANGELOG line starting `extension-kit:`.
 * Add a symbol only when an extension really needs it and core is willing to
 * keep it stable.
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
export type { SearchSource, SearchSourceContext } from './search/sources.js';
export type { SearchHit } from '@greenhouse/types/search';
export { entityUrl, parseEntityUrl } from '@greenhouse/types/entity-links';
export type { EntityRef, ExtensionEntityKindDef } from '@greenhouse/types/entity-links';
/** @deprecated The Home workbench was removed in 3.0; recipes are ignored. Removed in 4.0. */
export type WidgetRecipe = unknown;
export type { FeatureFlag } from '@greenhouse/types/features';
export type { WorkspaceSettingDef } from '@greenhouse/types/workspace-settings';
export type { GreenhouseConfig } from '@greenhouse/types/config';

export { logger } from '@greenhouse/utils/logger';

// ─── Compatibility ──────────────────────────────────────
export { EXTENSION_SDK } from './extensions/compat.js';

// ─── Actors, feature flags, the platform runtime ────────
export { humanActor, delegatedAgentActor } from './platform/actor.js';
export { userHasFeature } from './auth/features.js';
export { getPlatformRuntime, runBoundPlatformOperation } from './platform/runtime.js';
export type { PlatformHandlerContext } from './platform/runtime.js';

// ─── Registries an extension contributes to ─────────────
export type { DriveScopeDef } from './drive/access.js';
export type {
  ExtensionExportSource,
  ExportColumn,
  ExportDataset,
  ExportSourceContext,
} from './tools/export-sources.js';
export { CITE_URL_INSTRUCTION } from './tools/cite-url.js';

// ─── Files and storage ──────────────────────────────────
export { driveKeyFor, getObjectAtKey, putObjectAtKey } from './storage/uploads.js';
export type { StoredObject } from './storage/uploads.js';
export { safeDriveContentType, validateDriveUpload, MAX_DRIVE_FILE_SIZE } from './drive/upload-policy.js';
export type { DriveUploadCandidate, DriveUploadValidation } from './drive/upload-policy.js';
export { extractText, MAX_READABLE_BYTES, DEFAULT_MAX_CHARS, HARD_MAX_CHARS } from './files/extract-text.js';
export type { ExtractResult, ExtractFailureReason } from './files/extract-text.js';

// ─── CLI helpers (for `commands`) ───────────────────────
export { heading, dim, openDb, parseFlags, flagStr, flagNum, table } from './cli/commands/shared.js';

// ─── Platform kernel ────────────────────────────────────
export {
  compileApp,
  defineApp,
  canAccessRecord,
  effectiveUserId,
  fieldPolicyFor,
  resolveEntityPolicy,
} from '@greenhouse/platform-kernel';
export type {
  FieldDefinition,
  ActorContext,
  EntityPolicy,
  PlatformActionResult,
  ApplicationRegistration,
  PlatformActionHandler,
  AuthMethod,
} from '@greenhouse/platform-kernel';

// ─── Utilities ──────────────────────────────────────────
export { nowIso } from '@greenhouse/utils/date';
export { toErrorMessage } from '@greenhouse/utils/error';
export { safeJsonParse } from '@greenhouse/utils/json';
