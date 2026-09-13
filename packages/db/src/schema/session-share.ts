/**
 * Drizzle schema — Session shares.
 *
 * Tables: session_shares, session_share_reads
 *
 * Replaces the old session_mentions system.
 * Users can share sessions with specific team members or the entire team.
 * shared_with = '__team__' means shared with all internal users.
 *
 * Per-user read tracking is stored exclusively in session_share_reads, so a
 * team-wide share remains unread independently for every recipient.
 *
 * Both tables are domain-owned children of a session, so session_id carries a
 * real FK with ON DELETE CASCADE. Without it, deleting a session left share
 * rows behind and countUnread kept counting them — an unread badge nobody
 * could ever clear.
 */

import { pgTable, serial, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { sessions } from './session.js';

// ─── session_shares ───────────────────────────────────────

export const sessionShares = pgTable(
  'session_shares',
  {
    id: serial('id').primaryKey(),
    session_id: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    shared_with: text('shared_with').notNull(), // user_id or '__team__'
    shared_by: text('shared_by').notNull(),
    message: text('message'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_session_shares_user').on(table.shared_with),
    index('idx_session_shares_session').on(table.session_id),
    unique('uq_session_shares_session_user').on(table.session_id, table.shared_with),
  ],
);

// ─── session_share_reads (per-user read tracking) ─────────

export const sessionShareReads = pgTable(
  'session_share_reads',
  {
    id: serial('id').primaryKey(),
    session_id: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull(),
    read_at: timestamp('read_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    unique('uq_share_reads_session_user').on(table.session_id, table.user_id),
    index('idx_share_reads_user').on(table.user_id),
  ],
);
