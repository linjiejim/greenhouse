/**
 * Conversations: the chat transcript, who it is shared with, and the receipts
 * that make card buttons run once.
 *
 * Tables: conversations, messages, conversation_shares, conversation_share_reads,
 * card_action_receipts
 */

import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, uniqueIndex, unique } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, oneOf, updatedAt } from './_columns.js';

// ─── conversations ────────────────────────────────────────

export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    title: text('title'),
    status: text('status').notNull().default('active'),
    profile_id: text('profile_id').notNull().default('sprouty'),
    /** Owner (logical: a deleted member's transcripts stay for audit). */
    user_id: text('user_id'),
    app_id: text('app_id'),
    /** SessionChannel (@greenhouse/types/session): web / task / feishu / mobile / … */
    channel: text('channel').notNull().default('web'),
    metadata: json<Record<string, unknown>>('metadata', {}),
    /** The owner pinned it; recipients of a share pin on their read row instead. */
    pinned_at: at('pinned_at'),
    /** Manual order among the owner's pins, ascending; 0 = never reordered. */
    pin_position: integer('pin_position').notNull().default(0),
    /**
     * Rolling digest of the transcript up to `digest_upto_seq` (inclusive),
     * written only through `sessions.advanceDigest()`. NULL until the first fold.
     */
    digest: text('digest'),
    digest_upto_seq: integer('digest_upto_seq'),
    digest_updated_at: at('digest_updated_at'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    index('idx_conversations_user_updated').on(table.user_id, table.updated_at),
    index('idx_conversations_app_id').on(table.app_id),
    index('idx_conversations_channel').on(table.channel),
    index('idx_conversations_pinned').on(table.user_id, table.pinned_at),
  ],
);

// ─── messages ─────────────────────────────────────────────

/**
 * Structured parts of a message besides its Markdown body: knowledge
 * references, attached / generated images and the pipeline (tool steps and the
 * rich cards rendered from them). Persisted so history renders the same cards.
 */
export interface MessageParts {
  references?: unknown[];
  images?: unknown[];
  pipeline?: unknown[];
}

export const messages = pgTable(
  'messages',
  {
    id: id(),
    session_id: text('session_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    /** Canonical Markdown body. */
    content: text('content').notNull(),
    parts: json<MessageParts>('parts', {}),
    reasoning: text('reasoning'),
    /** Registry model id that produced an assistant turn; null otherwise. */
    model: text('model'),
    input_tokens: integer('input_tokens'),
    output_tokens: integer('output_tokens'),
    cached_tokens: integer('cached_tokens'),
    reasoning_tokens: integer('reasoning_tokens'),
    duration_ms: integer('duration_ms'),
    seq: integer('seq').notNull(),
    /**
     * The client's id for a user turn (`POST /api/chat` `client_turn_id`): a resend
     * of the same turn is refused as a duplicate instead of saved and run twice.
     */
    client_turn_id: text('client_turn_id'),
    created_at: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_messages_session_seq').on(table.session_id, table.seq),
    uniqueIndex('uq_messages_session_client_turn')
      .on(table.session_id, table.client_turn_id)
      .where(sql`${table.client_turn_id} IS NOT NULL`),
  ],
);

// ─── conversation_shares ──────────────────────────────────

export const conversationShares = pgTable(
  'conversation_shares',
  {
    id: id(),
    session_id: text('session_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** A member id, or `__team__` for everyone. */
    shared_with: text('shared_with').notNull(),
    shared_by: text('shared_by').notNull(),
    message: text('message'),
    created_at: createdAt(),
  },
  (table) => [
    index('idx_conversation_shares_user').on(table.shared_with),
    unique('uq_conversation_shares_session_user').on(table.session_id, table.shared_with),
  ],
);

/** A recipient's state on a shared conversation: when they last read it, and their own pin. */
export const conversationShareReads = pgTable(
  'conversation_share_reads',
  {
    id: id(),
    session_id: text('session_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull(),
    read_at: at('read_at'),
    pinned_at: at('pinned_at'),
    pin_position: integer('pin_position').notNull().default(0),
  },
  (table) => [
    unique('uq_conversation_share_reads_session_user').on(table.session_id, table.user_id),
    index('idx_conversation_share_reads_user').on(table.user_id),
  ],
);

// ─── card_action_receipts ─────────────────────────────────

export const CARD_RECEIPT_KINDS = ['task_capture'] as const;
export const CARD_RECEIPT_STATUSES = ['processing', 'succeeded', 'failed'] as const;

/**
 * Exactly-once receipt for a person clicking an actionable card in a persisted
 * assistant message: a refresh, retry or second tab cannot replay a
 * non-idempotent action (apply a schema plan, capture a task).
 */
export const cardActionReceipts = pgTable(
  'card_action_receipts',
  {
    id: id(),
    session_id: text('session_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull(),
    kind: text('kind').notNull(),
    request_hash: text('request_hash').notNull(),
    status: text('status', { enum: CARD_RECEIPT_STATUSES }).notNull(),
    result: json<Record<string, unknown>>('result', {}),
    error: text('error'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    index('idx_card_action_receipts_session').on(table.session_id),
    index('idx_card_action_receipts_user').on(table.user_id),
    oneOf('chk_card_action_receipts_status', table.status, CARD_RECEIPT_STATUSES),
  ],
);

export type SessionRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type SessionShareRow = typeof conversationShares.$inferSelect;
export type SessionShareReadRow = typeof conversationShareReads.$inferSelect;
export type ChatArtifactReceiptRow = typeof cardActionReceipts.$inferSelect;
