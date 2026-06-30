/**
 * API client barrel for the Greenhouse backend.
 *
 * Implementations live in ./api/<domain>.ts as hc (Hono RPC) typed calls over
 * the @greenhouse/contract AppType — response shapes are checked against the
 * server's actual implementation at compile time. Streaming (chat, sync apply)
 * and FormData (upload) endpoints stay on raw authFetch; see ./api/client.ts
 * for the conventions.
 */

import type { StreamingEvent } from './stream-events';

// Re-export all API types for backward compatibility
// (so existing `import { Session } from './api'` still works)
export type {
  ProfileCapability,
  Profile,
  ProfileUsage,
  ProfileDetail,
  UsageSummary,
  Session,
  Message,
  SessionUsage,
  UploadResult,
  FeatureRequest,
  UserUsageSummary,
  ShareableUser,
  UserPrompt,
  ShareItem,
  ShareInfo,
  ScheduledTask,
  ScheduledTaskInput,
  TaskRunSummary,
  SessionTag,
  SessionGroup,
} from '@greenhouse/types/api';

export { estimateCost, formatTokens, formatDuration } from '@greenhouse/types/api';

export type StreamEvent = StreamingEvent;

// ─── Domain modules (hc-typed unless noted) ──────────────

export * from './api/profiles';
export * from './api/sessions';
export * from './api/shares';
export * from './api/admin';
export * from './api/tools';
export * from './api/tasks';
export * from './api/prompts';
export * from './api/settings';
export * from './api/chat'; // streaming + desktop surface — raw authFetch
export * from './api/upload'; // FormData — raw authFetch

// Session tag API functions (hc-typed)
export {
  listSessionTags,
  createSessionTag,
  updateSessionTag,
  deleteSessionTag,
  reorderSessionTags,
  addTagToSession,
  removeTagFromSession,
} from './api/session-tags';

// Session group (folder) API functions (hc-typed)
export {
  listSessionGroups,
  createSessionGroup,
  updateSessionGroup,
  deleteSessionGroup,
  reorderSessionGroups,
  reorderGroupMembers,
} from './api/session-groups';
