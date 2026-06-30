/**
 * Drizzle schema — Email account connections (PostgreSQL).
 *
 * Tables: email_accounts
 *
 * Per-user IMAP/SMTP email account bindings. Supports multiple accounts
 * per user. Credentials are AES-256-GCM encrypted.
 */

import { pgTable, serial, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { users } from './user.js';

// ─── email_accounts ───────────────────────────────────────

export const emailAccounts = pgTable(
  'email_accounts',
  {
    id: serial('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['imap'] }).notNull(),
    email_address: text('email_address').notNull(), // actual email address
    display_name: text('display_name'), // From header display name
    credentials: text('credentials').notNull(), // AES-256-GCM encrypted JSON
    config: text('config').notNull().default('{}'), // JSON: signature, defaults, etc.
    status: text('status', { enum: ['active', 'disabled', 'auth_expired', 'error'] })
      .notNull()
      .default('active'),
    error_message: text('error_message'),
    last_synced_at: timestamp('last_synced_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    unique('uq_email_accounts_user_provider_address').on(table.user_id, table.provider, table.email_address),
    index('idx_email_accounts_user').on(table.user_id),
    index('idx_email_accounts_user_status').on(table.user_id, table.status),
  ],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type EmailAccountRow = typeof emailAccounts.$inferSelect;
export type EmailProvider = EmailAccountRow['provider'];
export type EmailAccountStatus = EmailAccountRow['status'];
