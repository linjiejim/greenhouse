/**
 * Drizzle schema — Session shares.
 *
 * Tables: session_shares, session_share_reads
 *
 * Replaces the old session_mentions system.
 * Users can share sessions with specific team members or the entire team.
 * shared_with = '__team__' means shared with all internal users.
 *
 * Per-user read tracking is stored in session_share_reads — this solves the
 * problem where a single __team__ row's read_at would mark the share as read
 * for everyone the moment any one user opens it.
 */

import { pgTable, serial, text, timestamp, index, unique } from 'drizzle-orm/pg-core';

// ─── session_shares ───────────────────────────────────────

export const sessionShares = pgTable(
  'session_shares',
  {
    id: serial('id').primaryKey(),
    session_id: text('session_id').notNull(),
    shared_with: text('shared_with').notNull(), // user_id or '__team__'
    shared_by: text('shared_by').notNull(),
    message: text('message'),
    /** @deprecated Use session_share_reads for per-user read status. */
    read_at: timestamp('read_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_session_shares_user').on(table.shared_with),
    index('idx_session_shares_session').on(table.session_id),
    index('idx_session_shares_unread').on(table.shared_with, table.read_at),
    unique('uq_session_shares_session_user').on(table.session_id, table.shared_with),
  ],
);

// ─── session_share_reads (per-user read tracking) ─────────

export const sessionShareReads = pgTable(
  'session_share_reads',
  {
    id: serial('id').primaryKey(),
    session_id: text('session_id').notNull(),
    user_id: text('user_id').notNull(),
    read_at: timestamp('read_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    unique('uq_share_reads_session_user').on(table.session_id, table.user_id),
    index('idx_share_reads_user').on(table.user_id),
  ],
);
