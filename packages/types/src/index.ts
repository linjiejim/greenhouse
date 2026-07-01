/**
 * Shared types — re-export everything from one place.
 *
 * Usage: import type { Session, Message, StreamingEvent } from '../types';
 */

// DB row types & input contracts
export type { SessionRow, SessionChannel, MessageRow, MessageInput, PipelineStep, Reference } from './session.js';

// API response types & shared client types
export type {
  // Auth
  UserRole,
  AuthenticatedUser,
  // Profile
  Profile,
  ProfileCapability,
  ProfileUsage,
  ProfileDetail,
  UsageSummary,
  // Session (API shape)
  Session,
  Message,
  SessionUsage,
  // Upload
  UploadResult,
  // Knowledge base
  KnowledgeDoc,
  KnowledgeDocVersion,
  KnowledgeSearchResult,
  KnowledgeGenerateResult,
  ChangeProposal,
  ApplyResult,
  // Feature Request
  FeatureRequest,
  // User & Usage
  UserUsageSummary,
  ShareableUser,
  // Prompt
  UserPrompt,
  // Share
  ShareItem,
  ShareInfo,
  // Streaming
  StreamingEvent,
  StreamEventCallbacks,
  TextDeltaEvent,
  TitleEvent,
  FinishEvent,
  StepFinishEvent,
  ErrorEvent,
} from './api.js';

export {
  // Functions (not just types)
  estimateCost,
  formatTokens,
  formatDuration,
  handleStreamEvent,
  readNdjsonStream,
} from './api.js';

// Feature flags (per-user experimental feature registry)
export type { FeatureFlag, FeatureKey } from './features.js';
export { FEATURE_FLAGS, FEATURE_FLAG_KEYS, getFeatureFlag, featureDefault } from './features.js';

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

// Agent profile manifest — TYPES ONLY here so the web bundle never pulls in
// zod. Server code imports the schema *values* from '@greenhouse/types/profile-manifest'.
export type {
  Capability,
  AvatarConfig,
  ModelOptions,
  ModelChoice,
  AccessConfig,
  ModelConfigInput,
  ProfileManifest,
  ProfileData,
  SystemProfile,
  CustomBaseProfileId,
} from './profile-manifest.js';
