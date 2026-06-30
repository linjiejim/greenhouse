/**
 * Email account service (PostgreSQL).
 *
 * Per-user email account storage with encrypted credentials.
 * Supports multi-account per user (generic IMAP/SMTP).
 */

import { eq, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { emailAccounts } from '../schema/index.js';
import type { EmailAccountRow, EmailProvider, EmailAccountStatus } from '../schema/email-account.js';

export interface EmailAccountInput {
  user_id: string;
  provider: EmailProvider;
  email_address: string;
  display_name?: string;
  credentials: string; // pre-encrypted
  config?: Record<string, unknown>;
}

export interface EmailAccountUpdateInput {
  display_name?: string;
  credentials?: string; // pre-encrypted
  config?: Record<string, unknown>;
  status?: EmailAccountStatus;
  error_message?: string | null;
  last_synced_at?: string | null;
}

/** Per-user email account CRUD (multi-account, IMAP/SMTP). */
export function createEmailAccountService(db: Db) {
  const service = {
    async create(input: EmailAccountInput): Promise<EmailAccountRow> {
      const now = nowIso();
      const rows = await db
        .insert(emailAccounts)
        .values({
          user_id: input.user_id,
          provider: input.provider,
          email_address: input.email_address,
          display_name: input.display_name ?? null,
          credentials: input.credentials,
          config: input.config ? JSON.stringify(input.config) : '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .returning();

      return rows[0]!;
    },

    async getById(id: number): Promise<EmailAccountRow | undefined> {
      const rows = await db.select().from(emailAccounts).where(eq(emailAccounts.id, id));
      return rows[0] ?? undefined;
    },

    /** List all email accounts for a user. */
    async listByUser(userId: string): Promise<EmailAccountRow[]> {
      const rows = await db
        .select()
        .from(emailAccounts)
        .where(eq(emailAccounts.user_id, userId))
        .orderBy(emailAccounts.created_at);
      return rows;
    },

    /** List all email accounts (super admin audit). */
    async listAll(): Promise<EmailAccountRow[]> {
      const rows = await db.select().from(emailAccounts).orderBy(emailAccounts.user_id, emailAccounts.created_at);
      return rows;
    },

    async update(id: number, updates: EmailAccountUpdateInput): Promise<EmailAccountRow | undefined> {
      const data: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.display_name !== undefined) data.display_name = updates.display_name;
      if (updates.credentials !== undefined) data.credentials = updates.credentials;
      if (updates.config !== undefined) data.config = JSON.stringify(updates.config);
      if (updates.status !== undefined) data.status = updates.status;
      if (updates.error_message !== undefined) data.error_message = updates.error_message;
      if (updates.last_synced_at !== undefined) data.last_synced_at = updates.last_synced_at;

      const rows = await db.update(emailAccounts).set(data).where(eq(emailAccounts.id, id)).returning();
      return rows[0] ?? undefined;
    },

    async delete(id: number): Promise<boolean> {
      const result = await db.delete(emailAccounts).where(eq(emailAccounts.id, id)).returning();
      return result.length > 0;
    },

    /** Count accounts for a user (enforce limit). */
    async countByUser(userId: string): Promise<number> {
      const result = await db
        .select({ count: sql<string>`count(*)` })
        .from(emailAccounts)
        .where(eq(emailAccounts.user_id, userId));
      return Number(result[0]?.count ?? 0);
    },
  };
  return service;
}

export type EmailAccountService = ReturnType<typeof createEmailAccountService>;
