/**
 * Email service — per-user mailbox bindings + the send audit log (PostgreSQL).
 *
 * Passwords arrive here already encrypted; this layer never touches crypto
 * (same split as provider-tokens). `listByUser` returns full rows including the
 * ciphertext — the HTTP layer is responsible for projecting it away, and the
 * only in-process consumer that needs it is the client factory.
 */

import { and, count, eq, gte, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { emailAccounts, emailSendLog } from '../schema/index.js';
import type { EmailAccountRow, EmailSendLogRow, EmailAccountPreset } from '../schema/email.js';

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
  /** Already AES-256-GCM encrypted by the caller. */
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
  password_encrypted?: string;
  status?: EmailAccountRow['status'];
  error_message?: string | null;
  last_verified_at?: string | null;
}

export interface EmailSendLogInput {
  user_id: string;
  account_scope: EmailSendLogRow['account_scope'];
  account_id?: number | null;
  from_address: string;
  subject: string;
  recipients: string[];
  attachment_count?: number;
  origin: EmailSendLogRow['origin'];
  session_id?: string | null;
  task_id?: number | null;
  status: EmailSendLogRow['status'];
  error_message?: string | null;
}

export function createEmailService(db: Db) {
  const service = {
    // ─── Accounts ────────────────────────────────────────

    async createAccount(input: EmailAccountInput): Promise<EmailAccountRow> {
      const now = nowIso();
      const [inserted] = await db
        .insert(emailAccounts)
        .values({
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
          password_encrypted: input.password_encrypted,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return inserted!;
    },

    async getAccount(id: number): Promise<EmailAccountRow | undefined> {
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

    async updateAccount(id: number, updates: EmailAccountUpdateInput): Promise<EmailAccountRow | undefined> {
      const set: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.display_name !== undefined) set.display_name = updates.display_name;
      if (updates.imap_host !== undefined) set.imap_host = updates.imap_host;
      if (updates.imap_port !== undefined) set.imap_port = updates.imap_port;
      if (updates.smtp_host !== undefined) set.smtp_host = updates.smtp_host;
      if (updates.smtp_port !== undefined) set.smtp_port = updates.smtp_port;
      if (updates.use_tls !== undefined) set.use_tls = updates.use_tls;
      if (updates.use_proxy !== undefined) set.use_proxy = updates.use_proxy;
      if (updates.username !== undefined) set.username = updates.username;
      if (updates.password_encrypted !== undefined) set.password_encrypted = updates.password_encrypted;
      if (updates.status !== undefined) set.status = updates.status;
      if (updates.error_message !== undefined) set.error_message = updates.error_message;
      if (updates.last_verified_at !== undefined) set.last_verified_at = updates.last_verified_at;

      const [updated] = await db.update(emailAccounts).set(set).where(eq(emailAccounts.id, id)).returning();
      return updated;
    },

    async deleteAccount(id: number): Promise<boolean> {
      const result = await db.delete(emailAccounts).where(eq(emailAccounts.id, id)).returning();
      return result.length > 0;
    },

    // ─── Send log ────────────────────────────────────────

    async logSend(input: EmailSendLogInput): Promise<EmailSendLogRow> {
      const [inserted] = await db
        .insert(emailSendLog)
        .values({
          user_id: input.user_id,
          account_scope: input.account_scope,
          account_id: input.account_id ?? null,
          from_address: input.from_address,
          subject: input.subject,
          recipients: JSON.stringify(input.recipients),
          attachment_count: input.attachment_count ?? 0,
          origin: input.origin,
          session_id: input.session_id ?? null,
          task_id: input.task_id ?? null,
          status: input.status,
          error_message: input.error_message ?? null,
          created_at: nowIso(),
        })
        .returning();
      return inserted!;
    },

    /**
     * Successful sends by this user in the trailing 24h. Failures do not count:
     * a rejected send consumed no provider quota, and counting them would let a
     * misconfigured account lock someone out of the mailbox that still works.
     */
    async countRecentSendsByUser(userId: string, sinceIso: string): Promise<number> {
      const rows = await db
        .select({ n: count() })
        .from(emailSendLog)
        .where(
          and(
            eq(emailSendLog.user_id, userId),
            eq(emailSendLog.status, 'sent'),
            gte(emailSendLog.created_at, sinceIso),
          ),
        );
      return rows[0]?.n ?? 0;
    },

    /** Successful sends from the shared system mailbox in the trailing 24h (all users). */
    async countRecentSendsByScope(scope: EmailSendLogRow['account_scope'], sinceIso: string): Promise<number> {
      const rows = await db
        .select({ n: count() })
        .from(emailSendLog)
        .where(
          and(
            eq(emailSendLog.account_scope, scope),
            eq(emailSendLog.status, 'sent'),
            gte(emailSendLog.created_at, sinceIso),
          ),
        );
      return rows[0]?.n ?? 0;
    },

    async listSendLog(opts: { userId?: string; limit?: number } = {}): Promise<EmailSendLogRow[]> {
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
      const query = db.select().from(emailSendLog).$dynamic();
      const filtered = opts.userId ? query.where(eq(emailSendLog.user_id, opts.userId)) : query;
      return await filtered.orderBy(sql`${emailSendLog.created_at} DESC`).limit(limit);
    },
  };
  return service;
}

export type EmailService = ReturnType<typeof createEmailService>;
