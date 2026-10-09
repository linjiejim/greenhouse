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

// Extension-facing registries (entity kinds, MCP groups, workbench recipes).
export { registerEntityKinds, extensionEntityKinds } from './entity-links.js';
export type { ExtensionEntityKindDef, CoreEntityKind, ExtensionEntityKind } from './entity-links.js';
export { registerMcpResourceGroups, allMcpResourceGroups } from './mcp.js';
export { registerWidgetRecipes, allWidgetRecipes } from './workbench.js';

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

// Plant avatars — ids, legacy mapping (resolver) and the writer rule. Runtime
// values are safe to re-export here: the module is dependency-free (no zod). The
// renderer lives in @greenhouse/ui/components/plant-avatar.
export type {
  PlantId,
  PlantState,
  PlantStateAlias,
  PlantStateInput,
  PlantMood,
  PlantTint,
  ResolvedPlantAvatar,
} from './plant-avatar.js';
export {
  PLANT_IDS,
  DEFAULT_PLANT,
  PLANT_STATES,
  STATE_ALIASES,
  PLANT_MOODS,
  PLANT_TINTS,
  TEMPLATE_PLANT,
  COLOR_FAMILY,
  PLANT_LEGACY_COLOR,
  IMPLICIT_POOL,
  isPlantId,
  isPlantMood,
  isPlantTint,
  avatarTint,
  hashSeed,
  legacyToPlant,
  legacyToMood,
  resolvePlantAvatar,
  MOOD_FACE_STYLE,
  withPlant,
  withTint,
  withMood,
  plantAvatarConfig,
} from './plant-avatar.js';

// Agent profile manifest — TYPES ONLY here so the web bundle never pulls in
// zod. Server code imports the schema *values* from '@greenhouse/types/profile-manifest'.
export type {
  AvatarConfig,
  SproutyColorId,
  SproutyAccessoryId,
  SproutyLeafStyleId,
  SproutyFaceStyleId,
} from './profile-manifest.js';
