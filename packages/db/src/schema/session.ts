/**
 * Drizzle schema — Session & Message tables (PostgreSQL).
 *
 * Tables: sessions, messages, chat_files, chat_artifact_receipts
 */

import { pgTable, text, timestamp, integer, doublePrecision, index, uniqueIndex } from 'drizzle-orm/pg-core';

// ─── sessions ─────────────────────────────────────────────

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    title: text('title'),
    status: text('status').notNull().default('active'),
    agent_instance_id: text('agent_instance_id'),
    profile_id: text('profile_id').notNull().default('team'),
    user_id: text('user_id'),
    app_id: text('app_id'),
    channel: text('channel').notNull().default('web'), // 'web' | 'api' | 'a2a' | 'task' | 'subagent' | 'workflow' | 'mission'
    // When this session was spawned by another session (via the spawn_session
    // tool), this points at the parent. Top-level sessions leave it null. Lineage
    // depth is tracked in metadata.spawn_depth.
    parent_session_id: text('parent_session_id'),
    rating: integer('rating'),
    comment: text('comment'),
    feedback: text('feedback'),
    metadata: text('metadata').notNull().default('{}'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_sessions_user').on(table.user_id),
    index('idx_sessions_coworker_history').on(table.user_id, table.agent_instance_id, table.updated_at, table.id),
    index('idx_sessions_app_id').on(table.app_id),
    index('idx_sessions_channel').on(table.channel),
    index('idx_sessions_parent').on(table.parent_session_id),
  ],
);

// ─── messages ─────────────────────────────────────────────

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    session_id: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    references_: text('references_').notNull().default('[]'),
    pipeline: text('pipeline').notNull().default('[]'),
    reasoning: text('reasoning'),
    /**
     * Registry model id that produced this assistant turn (`flash`, `pro`, …).
     * Null for user turns, server-written outcome messages, and every message
     * from before models became a per-turn choice.
     */
    model: text('model'),
    images: text('images').notNull().default('[]'),
    confidence: doublePrecision('confidence'),
    grounded: integer('grounded'),
    input_tokens: integer('input_tokens'),
    output_tokens: integer('output_tokens'),
    cached_tokens: integer('cached_tokens'),
    reasoning_tokens: integer('reasoning_tokens'),
    duration_ms: integer('duration_ms'),
    seq: integer('seq').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_messages_session').on(table.session_id),
    uniqueIndex('uq_messages_session_seq').on(table.session_id, table.seq),
  ],
);

// ─── chat_files ──────────────────────────────────────────

/**
 * Files attached to a chat turn, from either direction. Bytes live in object
 * storage; this row is the authenticated, session-owned handle.
 *
 * `source` says who put it there: `agent` for a tool's output (a data export),
 * `user` for something the person uploaded. Both are the same kind of handle —
 * session-scoped, downloaded through the same authenticated route — which is
 * why user uploads reuse this table instead of getting one of their own
 * (attachment convergence spec, D3). Images are the deliberate exception: they
 * stay on the flat public-read `/api/upload/:id` path because `<img src>`
 * cannot send a bearer token.
 */
export const chatFiles = pgTable(
  'chat_files',
  {
    id: text('id').primaryKey(),
    session_id: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    content_type: text('content_type').notNull(),
    size: integer('size').notNull(),
    storage_key: text('storage_key').notNull(),
    /** Existing rows are all tool output, hence the default. */
    source: text('source', { enum: ['agent', 'user'] })
      .notNull()
      .default('agent'),
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_chat_files_storage_key').on(table.storage_key),
    index('idx_chat_files_session').on(table.session_id),
    index('idx_chat_files_created_by').on(table.created_by),
  ],
);

export type ChatFileRow = typeof chatFiles.$inferSelect;

// ─── chat_artifact_receipts ─────────────────────────────

/**
 * Durable exactly-once receipt for a person clicking an actionable card in a
 * persisted assistant message. The business object remains the source of
 * truth; this row prevents a refresh, retry or second tab from replaying a
 * non-idempotent action such as applying a schema plan or capturing a Task.
 */
export const chatArtifactReceipts = pgTable(
  'chat_artifact_receipts',
  {
    id: text('id').primaryKey(),
    session_id: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull(),
    kind: text('kind', { enum: ['tables_schema_plan', 'task_capture'] }).notNull(),
    request_hash: text('request_hash').notNull(),
    status: text('status', { enum: ['processing', 'succeeded', 'failed'] }).notNull(),
    result: text('result').notNull().default('{}'),
    error: text('error'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_chat_artifact_receipts_session').on(table.session_id),
    index('idx_chat_artifact_receipts_user').on(table.user_id),
  ],
);

export type ChatArtifactReceiptRow = typeof chatArtifactReceipts.$inferSelect;
