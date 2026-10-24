/**
 * Members' own mailboxes (IMAP / SMTP). Outgoing mail is audited in
 * `audit_events` (app_id = 'email').
 *
 * Tables: email_accounts
 *
 * Only the password is secret (`password_enc`, AES-256-GCM with
 * PROVIDER_TOKEN_ENCRYPTION_KEY); connection settings are plain columns. The
 * shared greenhouse@ mailbox is deployment config, never a row here.
 */

import { boolean, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { at, createdAt, id, oneOf, updatedAt } from './_columns.js';
import { users } from './identity.js';

export const EMAIL_PRESETS = ['feishu', 'exmail', 'gmail', 'qq', '163', 'custom'] as const;
export const EMAIL_ACCOUNT_STATUSES = ['active', 'disabled', 'error'] as const;

export const emailAccounts = pgTable(
  'email_accounts',
  {
    id: id(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email_address: text('email_address').notNull(),
    display_name: text('display_name'),
    /** UI hint only; behavior follows host / port / use_proxy. */
    preset: text('preset', { enum: EMAIL_PRESETS }).notNull().default('custom'),
    imap_host: text('imap_host').notNull(),
    imap_port: integer('imap_port').notNull(),
    smtp_host: text('smtp_host').notNull(),
    smtp_port: integer('smtp_port').notNull(),
    use_tls: boolean('use_tls').notNull().default(true),
    use_proxy: boolean('use_proxy').notNull().default(false),
    username: text('username').notNull(),
    password_enc: text('password_enc').notNull(),
    status: text('status', { enum: EMAIL_ACCOUNT_STATUSES }).notNull().default('active'),
    error_message: text('error_message'),
    last_verified_at: at('last_verified_at'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    unique('uq_email_accounts_user_address').on(table.user_id, table.email_address),
    index('idx_email_accounts_user').on(table.user_id),
    oneOf('chk_email_accounts_preset', table.preset, EMAIL_PRESETS),
    oneOf('chk_email_accounts_status', table.status, EMAIL_ACCOUNT_STATUSES),
  ],
);

export type EmailAccountRow = typeof emailAccounts.$inferSelect;
export type EmailAccountPreset = EmailAccountRow['preset'];
export type EmailAccountStatus = EmailAccountRow['status'];
export type EmailAccountScope = 'personal' | 'shared';
export type EmailSendOrigin = 'chat' | 'automation' | 'account-security';
