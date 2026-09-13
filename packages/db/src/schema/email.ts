/**
 * Drizzle schema — Email tables (PostgreSQL).
 *
 * Tables: email_accounts, email_send_log
 *
 * Per-user IMAP/SMTP mailbox bindings plus a send audit trail. There is no
 * OAuth provider column: every account is generic IMAP/SMTP (Feishu, Gmail via
 * app password, QQ, 163, corporate Exchange) — see the email revival spec, D1.
 *
 * Connection settings are plain columns on purpose; only the password is
 * ciphertext. Encrypting the whole credential blob (as the deleted 0.18.0
 * module did) hides host/port from every operator query while protecting
 * nothing extra.
 */

import { pgTable, serial, text, integer, boolean, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { users } from './user.js';

// ─── email_accounts ──────────────────────────────────────

export const emailAccounts = pgTable(
  'email_accounts',
  {
    id: serial('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email_address: text('email_address').notNull(),
    display_name: text('display_name'),
    /** Preset the account was created from — UI hint only, never a code branch. */
    preset: text('preset', { enum: ['feishu', 'exmail', 'gmail', 'qq', '163', 'custom'] })
      .notNull()
      .default('custom'),
    imap_host: text('imap_host').notNull(),
    imap_port: integer('imap_port').notNull(),
    smtp_host: text('smtp_host').notNull(),
    smtp_port: integer('smtp_port').notNull(),
    use_tls: boolean('use_tls').notNull().default(true),
    /** Route this account's IMAP/SMTP through MAIL_EGRESS_PROXY (Gmail from CN). */
    use_proxy: boolean('use_proxy').notNull().default(false),
    username: text('username').notNull(),
    /** AES-256-GCM, PROVIDER_TOKEN_ENCRYPTION_KEY — never logged, never returned. */
    password_encrypted: text('password_encrypted').notNull(),
    status: text('status', { enum: ['active', 'disabled', 'error'] })
      .notNull()
      .default('active'),
    error_message: text('error_message'),
    last_verified_at: timestamp('last_verified_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    unique('uq_email_account_user_address').on(table.user_id, table.email_address),
    index('idx_email_accounts_user').on(table.user_id),
  ],
);

// ─── email_send_log ──────────────────────────────────────

/**
 * Every send attempt, successful or not. Two consumers: the audit trail, and
 * the daily rate limiter (which counts rows rather than keeping process state,
 * so a restart cannot reset someone's quota).
 *
 * No FK to email_accounts: the log has to outlive the binding it describes
 * (cross-domain loose association, per the db AGENTS.md FK policy).
 */
export const emailSendLog = pgTable(
  'email_send_log',
  {
    id: serial('id').primaryKey(),
    /** Who sent it; for automation delivery this is the task owner. */
    user_id: text('user_id').notNull(),
    account_scope: text('account_scope', { enum: ['personal', 'shared'] }).notNull(),
    /** email_accounts.id for personal sends; NULL for the shared system mailbox. */
    account_id: integer('account_id'),
    from_address: text('from_address').notNull(),
    subject: text('subject').notNull(),
    /** JSON array of every recipient address (to + cc + bcc merged). */
    recipients: text('recipients').notNull().default('[]'),
    attachment_count: integer('attachment_count').notNull().default(0),
    origin: text('origin', { enum: ['chat', 'automation', 'account-security'] }).notNull(),
    session_id: text('session_id'),
    task_id: integer('task_id'),
    status: text('status', { enum: ['sent', 'failed'] }).notNull(),
    error_message: text('error_message'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_email_send_log_user_time').on(table.user_id, table.created_at),
    index('idx_email_send_log_scope_time').on(table.account_scope, table.created_at),
  ],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type EmailAccountRow = typeof emailAccounts.$inferSelect;
export type EmailAccountPreset = EmailAccountRow['preset'];
export type EmailAccountStatus = EmailAccountRow['status'];
export type EmailSendLogRow = typeof emailSendLog.$inferSelect;
export type EmailAccountScope = EmailSendLogRow['account_scope'];
export type EmailSendOrigin = EmailSendLogRow['origin'];
