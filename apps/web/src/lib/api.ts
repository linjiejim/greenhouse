/**
 * API client barrel for the Greenhouse backend.
 *
 * Implementations live in ./api/<domain>.ts as hc (Hono RPC) typed calls over
 * the @greenhouse/contract AppType — response shapes are checked against the
 * server's actual implementation at compile time. Streaming (chat) and
 * FormData (upload) endpoints stay on raw authFetch; see ./api/client.ts
 * for the conventions.
 */

import type { StreamingEvent } from './stream-events';

// Re-export all API types for backward compatibility
// (so existing `import { Session } from './api'` still works)
export type {
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
} from '@greenhouse/types/api';

export { formatTokens, formatDuration } from '@greenhouse/types/api';

export type StreamEvent = StreamingEvent;

// ─── Domain modules (hc-typed unless noted) ──────────────

export * from './api/profiles';
export * from './api/sessions';
export * from './api/shares';
export * from './api/admin';
export * from './api/tools';
export * from './api/tasks';
export * from './api/notifications';
export * from './api/cost-value';
export * from './api/prompts';
export * from './api/chat'; // streaming + Client Action result surface — raw authFetch
export * from './api/upload'; // FormData — raw authFetch
