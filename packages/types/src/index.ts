/**
 * Shared types — re-export the commonly consumed surface from one place.
 *
 * Consumers that only need types import from here; runtime helpers and the
 * zod schemas stay on their dedicated subpaths (`@greenhouse/types/<module>`)
 * so a browser bundle never pulls in more than it uses.
 */

// DB row types & input contracts
export type { SessionRow, SessionChannel, MessageRow, MessageInput, PipelineStep, Reference } from './session.js';

// API response types & shared client types
export type {
  UserRole,
  AuthenticatedUser,
  Profile,
  ProfileUsage,
  ProfileDetail,
  UsageSummary,
  Session,
  Message,
  SessionUsage,
  UploadResult,
  KnowledgeDoc,
  KnowledgeDocVersion,
  KnowledgeSearchHit,
  FeatureRequest,
  UserUsageSummary,
  ShareableUser,
  UserPrompt,
  ShareItem,
  ShareInfo,
  StreamingEvent,
  StreamEventCallbacks,
  TextDeltaEvent,
  TitleEvent,
  FinishEvent,
  StepFinishEvent,
  ErrorEvent,
} from './api.js';

export { formatTokens, formatDuration, handleStreamEvent, readNdjsonStream } from './api.js';

// Feature flags (per-user experimental feature registry)
export type { FeatureFlag, FeatureKey } from './features.js';
export { FEATURE_FLAGS, getFeatureFlag, featureDefault, allFeatureFlags, registerFeatureFlags } from './features.js';

// WebSocket message protocol
export type { ServerWsEvent, ClientWsEvent, OnlineUser } from './ws.js';

// Agent context types (frontend-specific but shared for type safety)
export type {
  PageContext,
  PageContextType,
  ContextOfType,
  QuickAction,
  ContextProviderDescriptor,
} from './agent-context.js';

// Workspace settings (DB-backed, admin-editable deployment config). Runtime
// values are safe to re-export here — the module is dependency-free (no zod).
export type {
  WorkspaceSettingGroup,
  WorkspaceSettingType,
  WorkspaceSettingDef,
  WorkspaceSettingKey,
  WorkspaceSettingSource,
  WorkspaceSettingView,
  WorkspaceBootstrap,
  ThemeTokens,
} from './workspace-settings.js';
export {
  WORKSPACE_SETTINGS,
  WORKSPACE_SETTING_KEYS,
  getWorkspaceSettingDef,
  sanitizeThemeTokens,
  LOGO_ALLOWED_MIME,
  LOGO_MAX_BYTES,
  LOGO_MAX_DATA_URL_LENGTH,
} from './workspace-settings.js';

// Agent profile manifest — TYPES ONLY here so the web bundle never pulls in
// zod. Server code imports the schema *values* from '@greenhouse/types/profile-manifest'.
export type {
  Capability,
  AvatarConfig,
  ProfileManifest,
  ProfileData,
  SproutyColorId,
  SproutyAccessoryId,
  SproutyLeafStyleId,
  SproutyFaceStyleId,
} from './profile-manifest.js';
