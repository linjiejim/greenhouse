/**
 * Session & message type definitions and schema.
 *
 * Canonical definitions live in src/types/session.ts.
 * This file re-exports for backward compatibility with existing api/ consumers.
 *
 * All CRUD operations live in @greenhouse/db services/sessions.ts (SessionService).
 */

export type {
  SessionChannel,
  SessionRow,
  MessageRow,
  PipelineStep,
  Reference,
  MessageInput,
} from '@greenhouse/types/session';
