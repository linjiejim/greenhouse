/**
 * Email service — per-user mailbox bindings + the send audit log (PostgreSQL).
 * Sends are `audit_events` rows (app_id 'email', action_id 'send'); the daily
 * limits count their `success` rows.
 *
 * Passwords arrive here already encrypted; this layer never touches crypto
 * (same split as provider-tokens). `listByUser` returns full rows including the
 * ciphertext — the HTTP layer is responsible for projecting it away, and the
 * only in-process consumer that needs it is the client factory.
 */

import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { newId } from '../ids.js';
import { auditEvents, emailAccounts } from '../schema/index.js';
import type { EmailAccountRow, EmailAccountPreset, EmailAccountScope, EmailSendOrigin } from '../schema/email.js';

/** `audit_events` coordinates of an outgoing mail. */
export const EMAIL_AUDIT_APP_ID = 'email';
export const EMAIL_SEND_ACTION_ID = 'send';

export interface EmailAccountInput {
  user_id: string;
  email_address: string;
  display_name?: string | null;
  preset?: EmailAccountPreset;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  use_tls?: boolean;
  use_proxy?: boolean;
  username: string;
  /** Already AES-256-GCM encrypted by the caller; stored in `password_enc`. */
  password_encrypted: string;
}

export interface EmailAccountUpdateInput {
  display_name?: string | null;
  imap_host?: string;
  imap_port?: number;
  smtp_host?: string;
  smtp_port?: number;
  use_tls?: boolean;
  use_proxy?: boolean;
  username?: string;
  /** Already encrypted; stored in `password_enc`. */
  password_encrypted?: string;
  status?: EmailAccountRow['status'];
  error_message?: string | null;
  last_verified_at?: string | null;
}

export type EmailSendStatus = 'sent' | 'failed';

/**
 * One outgoing mail as the email facade sees it. Stored as an `audit_events`
 * row (app_id 'email', action_id 'send'; result success = sent, error = failed).
 */
export interface EmailSendLogRow {
  id: string;
  user_id: string;
  account_scope: EmailAccountScope;
  account_id: string | null;
  from_address: string;
  subject: string;
  recipients: string[];
  attachment_count: number;
  origin: EmailSendOrigin;
  session_id: string | null;
  task_id: string | null;
  status: EmailSendStatus;
  error_message: string | null;
  created_at: string;
}

export interface EmailSendLogInput {
  /** The member the mail was sent for; empty for system mail with no member. */
  user_id: string;
  account_scope: EmailAccountScope;
  account_id?: string | number | null;
  from_address: string;
  subject: string;
  recipients: string[];
  attachment_count?: number;
  origin: EmailSendOrigin;
  session_id?: string | null;
  task_id?: string | number | null;
  status: EmailSendStatus;
  error_message?: string | null;
}

interface SendSummary {
  account_scope?: EmailAccountScope;
  account_id?: string | null;
  from_address?: string;
  subject?: string;
  recipients?: string[];
  attachment_count?: number;
  origin?: EmailSendOrigin;
  session_id?: string | null;
  task_id?: string | null;
  error_message?: string | null;
}

const SYSTEM_ACTOR = 'system';

function toSendLogRow(row: typeof auditEvents.$inferSelect): EmailSendLogRow {
  const summary = row.summary as SendSummary;
  return {
    id: row.id,
    user_id: row.actor_type === 'system' ? '' : row.actor_id,
    account_scope: summary.account_scope ?? 'personal',
    account_id: summary.account_id ?? null,
    from_address: summary.from_address ?? '',
    subject: summary.subject ?? '',
    recipients: Array.isArray(summary.recipients) ? summary.recipients : [],
    attachment_count: summary.attachment_count ?? 0,
    origin: summary.origin ?? 'chat',
    session_id: summary.session_id ?? null,
    task_id: summary.task_id ?? null,
    status: row.result === 'success' ? 'sent' : 'failed',
    error_message: summary.error_message ?? null,
    created_at: row.created_at,
  };
}

const isSend = and(eq(auditEvents.app_id, EMAIL_AUDIT_APP_ID), eq(auditEvents.action_id, EMAIL_SEND_ACTION_ID));

export function createEmailService(db: Db) {
  const service = {
    // ─── Accounts ────────────────────────────────────────

    async createAccount(input: EmailAccountInput): Promise<EmailAccountRow> {
      const now = nowIso();
      const [inserted] = await db
        .insert(emailAccounts)
        .values({
          id: newId('emailAccount'),
          user_id: input.user_id,
          email_address: input.email_address,
          display_name: input.display_name ?? null,
          preset: input.preset ?? 'custom',
          imap_host: input.imap_host,
          imap_port: input.imap_port,
          smtp_host: input.smtp_host,
          smtp_port: input.smtp_port,
          use_tls: input.use_tls ?? true,
          use_proxy: input.use_proxy ?? false,
          username: input.username,
          password_enc: input.password_encrypted,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return inserted!;
    },

    async getAccount(id: string): Promise<EmailAccountRow | undefined> {
      const rows = await db.select().from(emailAccounts).where(eq(emailAccounts.id, id));
      return rows[0];
    },

    async listAccountsByUser(userId: string): Promise<EmailAccountRow[]> {
      return await db
        .select()
        .from(emailAccounts)
        .where(eq(emailAccounts.user_id, userId))
        .orderBy(emailAccounts.created_at);
    },

    async updateAccount(id: string, updates: EmailAccountUpdateInput): Promise<EmailAccountRow | undefined> {
      const set: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.display_name !== undefined) set.display_name = updates.display_name;
      if (updates.imap_host !== undefined) set.imap_host = updates.imap_host;
      if (updates.imap_port !== undefined) set.imap_port = updates.imap_port;
      if (updates.smtp_host !== undefined) set.smtp_host = updates.smtp_host;
      if (updates.smtp_port !== undefined) set.smtp_port = updates.smtp_port;
      if (updates.use_tls !== undefined) set.use_tls = updates.use_tls;
      if (updates.use_proxy !== undefined) set.use_proxy = updates.use_proxy;
      if (updates.username !== undefined) set.username = updates.username;
      if (updates.password_encrypted !== undefined) set.password_enc = updates.password_encrypted;
      if (updates.status !== undefined) set.status = updates.status;
      if (updates.error_message !== undefined) set.error_message = updates.error_message;
      if (updates.last_verified_at !== undefined) set.last_verified_at = updates.last_verified_at;

      const [updated] = await db.update(emailAccounts).set(set).where(eq(emailAccounts.id, id)).returning();
      return updated;
    },

    async deleteAccount(id: string): Promise<boolean> {
      const result = await db.delete(emailAccounts).where(eq(emailAccounts.id, id)).returning();
      return result.length > 0;
    },

    // ─── Send log ────────────────────────────────────────

    async logSend(input: EmailSendLogInput): Promise<EmailSendLogRow> {
      const actorId = input.user_id || SYSTEM_ACTOR;
      const summary: SendSummary = {
        account_scope: input.account_scope,
        account_id: input.account_id == null ? null : String(input.account_id),
        from_address: input.from_address,
        subject: input.subject,
        recipients: input.recipients,
        attachment_count: input.attachment_count ?? 0,
        origin: input.origin,
        session_id: input.session_id ?? null,
        task_id: input.task_id == null ? null : String(input.task_id),
        error_message: input.error_message ?? null,
      };
      const [inserted] = await db
        .insert(auditEvents)
        .values({
          id: newId('auditEvent'),
          actor_id: actorId,
          actor_type: input.user_id ? 'human' : 'system',
          request_id: newId('auditEvent'),
          app_id: EMAIL_AUDIT_APP_ID,
          module_id: 'email',
          entity_id: 'message',
          record_id: null,
          action_id: EMAIL_SEND_ACTION_ID,
          capability: 'email.send',
          result: input.status === 'sent' ? 'success' : 'error',
          summary: summary as Record<string, unknown>,
          created_at: nowIso(),
        })
        .returning();
      return toSendLogRow(inserted!);
    },

    /**
     * Successful sends by this user in the trailing 24h. Failures do not count:
     * a rejected send consumed no provider quota, and counting them would let a
     * misconfigured account lock someone out of the mailbox that still works.
     */
    async countRecentSendsByUser(userId: string, sinceIso: string): Promise<number> {
      const rows = await db
        .select({ n: count() })
        .from(auditEvents)
        .where(
          and(
            isSend,
            eq(auditEvents.actor_id, userId),
            eq(auditEvents.result, 'success'),
            gte(auditEvents.created_at, sinceIso),
          ),
        );
      return rows[0]?.n ?? 0;
    },

    /** Successful sends from the shared system mailbox in the trailing 24h (all users). */
    async countRecentSendsByScope(scope: EmailAccountScope, sinceIso: string): Promise<number> {
      const rows = await db
        .select({ n: count() })
        .from(auditEvents)
        .where(
          and(
            isSend,
            sql`${auditEvents.summary}->>'account_scope' = ${scope}`,
            eq(auditEvents.result, 'success'),
            gte(auditEvents.created_at, sinceIso),
          ),
        );
      return rows[0]?.n ?? 0;
    },

    async listSendLog(opts: { userId?: string; limit?: number } = {}): Promise<EmailSendLogRow[]> {
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
      const rows = await db
        .select()
        .from(auditEvents)
        .where(opts.userId ? and(isSend, eq(auditEvents.actor_id, opts.userId)) : isSend)
        .orderBy(desc(auditEvents.created_at), desc(auditEvents.id))
        .limit(limit);
      return rows.map(toSendLogRow);
    },
  };
  return service;
}

export type EmailService = ReturnType<typeof createEmailService>;
