/**
 * The import surface for extensions — everything a plugin's api half
 * (`plugins/<id>/api/`) may use from core, re-exported from one place as
 * `@greenhouse/api/extension-kit` so extension code does not depend on the core
 * folder layout.
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
export { defineExtension, extensionPath } from './plugin-host/define.js';
export type {
  GreenhouseExtension,
  ExtensionRoute,
  ExtensionApplication,
  ExtensionJob,
  ExtensionCommand,
  ExtensionBootContext,
} from './plugin-host/define.js';

export { defineTool } from './tools/define.js';
export type { ToolModule, ToolMeta, LazyToolContext, ToolCategory } from './tools/define.js';

export type { AppEnv } from './app-env.js';
export { getAuthUser, requireFeature, requireInternal, requireSuper } from './auth/middleware.js';

export { getDb, getExtensionServices } from '@greenhouse/db';
export type { DatabaseProvider, Db } from '@greenhouse/db';

export { GREENHOUSE_CONFIG, extensionEnabled, resolvePackPath } from './config/greenhouse-config.js';
export { getWorkspaceValue } from './settings/workspace-config.js';

export type { FeaturePointDef } from './plugin-host/feature-points.js';
export type { SearchSource, SearchSourceContext } from './search/sources.js';
export type { SearchHit } from '@greenhouse/types/search';
export { entityUrl, parseEntityUrl } from '@greenhouse/types/entity-links';
export type { EntityRef, ExtensionEntityKindDef } from '@greenhouse/types/entity-links';
export type { FeatureFlag } from '@greenhouse/types/features';
export type { WorkspaceSettingDef } from '@greenhouse/types/workspace-settings';
export type { GreenhouseConfig } from '@greenhouse/types/config';

export { logger } from '@greenhouse/utils/logger';

// ─── Compatibility ──────────────────────────────────────
export { EXTENSION_SDK } from './plugin-host/compat.js';

// ─── Actors, feature flags, the platform runtime ────────
export { humanActor, delegatedAgentActor } from './plugin-host/actor.js';
export { userHasFeature } from './auth/features.js';
export { getPlatformRuntime, runBoundPlatformOperation } from './plugin-host/runtime.js';
export type { PlatformHandlerContext } from './plugin-host/runtime.js';

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

// Host capabilities used by official plugin packages.
export { getUtcMonthPeriod, type UserRow } from '@greenhouse/db';
export { findBudgetRefusal } from './usage/budget-errors.js';
export {
  restoreSpendLease,
  reserveSpend,
  settleServiceFact,
  type MeteringScope,
  type SpendAttribution,
  type SpendLease,
  meteringClientForRequest,
  currentMeteringScope,
} from './usage/metering.js';
export {
  effectiveServicePrice,
  serviceUnitCostMicros,
  syncPriceOverrides,
  unitPriceSnapshot,
} from './usage/pricing.js';
export { getWorkspaceFlag, getWorkspaceFlagState, getWorkspaceBootstrap } from './settings/workspace-config.js';
export { toRowId } from '@greenhouse/utils/id';
export {
  createModelFromConfig,
  resolveModelConfig,
  buildProviderOptions,
  type ModelConfig,
} from '@greenhouse/agent-core';
export { extractJson } from '@greenhouse/utils/json';
export { sanitizeForPrompt } from './security/security.js';
export { type UserRole } from './auth/token.js';
export { createProviderAttemptBudgetHook } from './llm/usage-budget.js';
export {
  cabinetDownloadUrl,
  MAX_AGENT_UPLOAD_BYTES,
  uploadCabinetFile,
  type CabinetFileView,
  readCabinetFileBytes,
} from './drive/kb-cabinet.js';
export { PLATFORM_ORG_ID } from './plugin-host/runtime.js';
export { at, createdAt, id, json, oneOf, updatedAt } from '@greenhouse/db/plugin-schema';
export { users } from '@greenhouse/db/plugin-schema';
export { newId } from '@greenhouse/db';
export { findSensitiveSpans, redactEvidence } from './security/evidence.js';

export type { HydrateContext } from './activity/activity-log.js';
export type { ActivityAuditRow } from '@greenhouse/db';

export { groupFrictions, clip } from './usage/summary-insights.js';

export { isUniqueViolation } from '@greenhouse/utils/error';

export { isPublicNetworkAddress } from './security/network.js';

export { decryptToken, encryptToken, isEncryptionConfigured } from './auth/crypto.js';

export { resolveHistoryBudget, windowMessagesByBudget } from '@greenhouse/agent-core';

export { resolveProfileAsync } from './profiles/profile.js';

export { resolveExtensionPromptContext } from './plugin-host/prompt-context.js';

export { sanitizeChatMessagesForPrompt, sanitizeUserMessageForPrompt } from './chat/user-message.js';

export { formatDigestSection, scheduleDigestFold } from './chat/digest.js';

export { flattenRichOutput } from './notifications/render.js';

export { resolveConversationFiles } from './files/conversation-files.js';

export { issueUserSession } from './auth/identity-providers.js';

export { checkRateLimit } from './security/security.js';

export { getRequestSourceIp } from './security/request-ip.js';

export { readSessionDigest } from '@greenhouse/db';
export type { ToolRegistry } from './agent.js';
export type { AgentGenerate, HeadlessMessage } from './agent-runtime/run-agent.js';
export { channelAgentRuntime, runAgentTurn } from './agent-runtime/channel-runtime.js';
export type { AuthUser } from './auth/token.js';
export { auditEvents, conversations } from '@greenhouse/db/plugin-schema';

export type { IdentityProvider } from './auth/identity-providers.js';
export { createIdentityProviderRoutes, bindProviderIdentity, isLoginEligible } from './auth/identity-providers.js';
export type { NotificationTransport } from './notifications/transports.js';
export {
  automationDeliveryRecipient,
  parseAutomationResultNotificationPayload,
  buildTaskNotification,
  buildTaskEmail,
} from './scheduler/notify.js';

export { day } from '@greenhouse/db/plugin-schema';
export { DATA_DIR } from './paths.js';
export { createS3Client, type S3LiteClient } from './storage/s3-lite.js';
export { extensionSkillPackDirs } from './plugin-host/skill-packs.js';
export { notificationWebhookTransport } from './notifications/transports.js';
export { compareSemver, isValidSemver, bumpPatch } from '@greenhouse/utils/semver';
export type { DataScope, PlatformAuditHint } from '@greenhouse/platform-kernel';

export { activitySql, type ActivityCursor, type RecentWindow, type ActivityRunRow } from '@greenhouse/db';
export {
  scanRecentChanges,
  recentChangeDraft,
  type RecentChangeWindow,
  type RecentChangeLane,
  type RecentChangeSource,
  type RecentViewer,
} from './activity/recent-source.js';
export type { PlatformRuntime } from './plugin-host/runtime.js';
export type { ObjectRefSource, ObjectRefResolver, Resolved } from './routes/refs.js';
export type { TeamPrompt, TeamPromptDescriptor, TeamPromptArgument } from './hub-context/prompts.js';

export { listSavedPrompts, getSavedPrompt } from './hub-context/prompts.js';
export type { ExtensionAgentContext, AgentContextCaller, AgentContextPrompt } from './plugin-host/agent-context.js';

export { activityField, activityIdText, activityText } from './activity/values.js';

export { artifactReceiptResult } from './chat/artifact-actions.js';

export { claimArtifactAction } from './chat/artifact-actions.js';

export { isRowId } from '@greenhouse/utils/id';

export { flagBool } from './cli/commands/shared.js';

export { splitSub } from './cli/commands/shared.js';

export { fileLinks, files, shares, type FileLinkRow, type ShareRow } from '@greenhouse/db/plugin-schema';
export type { CatalogInput } from './hub-context/catalog.js';

export type { PlatformAuditEventRow } from '@greenhouse/db';

export type { FieldPolicy } from '@greenhouse/platform-kernel';

export { putUpload } from './storage/uploads.js';
export type { DriveFolderRow } from '@greenhouse/db';
export { getUpload } from './storage/uploads.js';
export { createCabinetFolder } from './drive/kb-cabinet.js';
export type { CabinetCaller } from './drive/kb-cabinet.js';
export { connectionManager } from './ws/connection-manager.js';
export { segmentForFts } from '@greenhouse/db';
export { buildSegmentedTsQuery } from '@greenhouse/db';
export { buildSnippet } from '@greenhouse/db';
export { jsonArrayToText } from '@greenhouse/db';
export { contentDisposition } from './http/content-disposition.js';
export { resolveDriveAccess } from './drive/access.js';
export { canWriteDrive } from './drive/access.js';
export { checkPromptInjection } from './security/security.js';
export { completeJson } from './llm/complete.js';
export { searchColumns } from '@greenhouse/db/plugin-schema';
export { folders } from '@greenhouse/db/plugin-schema';
export { queueMobilePush } from './notifications/push/queue.js';
export { workspaceTimeZone } from './hub-context/settings.js';
export { collectRetroAggregates } from './usage/summary.js';
export { monthKey } from './usage/summary.js';
export { retroMonth } from './usage/summary.js';
export type { RetroAggregates } from './usage/summary.js';
export type { FrictionErrorClass } from './usage/summary.js';
export { getAvailableProviders } from '@greenhouse/agent-core';
export { createOrganizationAttemptBudgetHook } from './llm/usage-budget.js';

export type { RecentChangeDraft } from './activity/recent-source.js';

export {
  readTeamContextConfig,
  type TeamContextConfig,
  type TeamContextDocumentSource,
} from './hub-context/settings.js';

export type { ToolResultAdapter } from '@greenhouse/agent-core';

export { runExtensionJob } from './scheduler/extension-job.js';

export { recordWrite, notify } from './plugin-host/governance.js';
export type { ExtensionDataSource, DataEntity, DataHandlerContext, DataRow } from './plugin-host/data-types.js';
export type { ExtensionEvents, ExtensionHooks } from './plugin-host/events.js';
export { createTableCrudService } from '@greenhouse/db';

export { projectReadableFields } from '@greenhouse/platform-kernel';
