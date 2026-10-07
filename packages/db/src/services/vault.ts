/**
 * Vault service — per-member login credentials the Bots may fill into web
 * pages without ever seeing them (PostgreSQL).
 *
 * Storage only: this layer stores and returns ciphertext as given; the API's
 * vault module encrypts (AES-256-GCM, AAD `vault:<user_id>:<item_id>:<field>`)
 * and decrypts at the fill boundary. Read paths for the HTTP API and the model
 * use `toMeta` shapes — ciphertext never leaves the API process.
 *
 * Design: docs/specs/20261005-personal-assistant-bots.md §8.
 */

import { randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { vaultItems, vaultAccessLog } from '../schema/index.js';
import type { VaultItemRow, VaultAccessLogRow } from '../schema/bots.js';

export interface VaultItemInsert {
  id: string;
  user_id: string;
  label: string;
  origins: string[];
  username_enc: string | null;
  username_hint: string;
  password_enc: string | null;
  totp_enc: string | null;
  policy: 'ask' | 'auto';
}

export interface VaultItemPatch {
  label?: string;
  origins?: string[];
  username_enc?: string | null;
  username_hint?: string;
  password_enc?: string | null;
  totp_enc?: string | null;
  policy?: 'ask' | 'auto';
  always_origins?: string[];
}

export type VaultAccessInput = Omit<typeof vaultAccessLog.$inferInsert, 'id' | 'created_at'>;

/** A fresh, unguessable item id (needed before encryption, since it is part of the AAD). */
export function newVaultItemId(): string {
  return `vlt_${randomBytes(10).toString('hex')}`;
}

export function createVaultService(db: Db) {
  return {
    async create(input: VaultItemInsert): Promise<VaultItemRow> {
      const now = nowIso();
      const [row] = await db
        .insert(vaultItems)
        .values({
          ...input,
          origins: JSON.stringify(input.origins),
          always_origins: '[]',
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    async list(userId: string): Promise<VaultItemRow[]> {
      return await db.select().from(vaultItems).where(eq(vaultItems.user_id, userId)).orderBy(vaultItems.label);
    },

    async get(userId: string, id: string): Promise<VaultItemRow | undefined> {
      const [row] = await db
        .select()
        .from(vaultItems)
        .where(and(eq(vaultItems.id, id), eq(vaultItems.user_id, userId)));
      return row;
    },

    async update(userId: string, id: string, patch: VaultItemPatch): Promise<VaultItemRow | undefined> {
      const set: Partial<typeof vaultItems.$inferInsert> = { updated_at: nowIso() };
      if (patch.label !== undefined) set.label = patch.label;
      if (patch.origins !== undefined) set.origins = JSON.stringify(patch.origins);
      if (patch.username_enc !== undefined) set.username_enc = patch.username_enc;
      if (patch.username_hint !== undefined) set.username_hint = patch.username_hint;
      if (patch.password_enc !== undefined) set.password_enc = patch.password_enc;
      if (patch.totp_enc !== undefined) set.totp_enc = patch.totp_enc;
      if (patch.policy !== undefined) set.policy = patch.policy;
      if (patch.always_origins !== undefined) set.always_origins = JSON.stringify(patch.always_origins);
      const [row] = await db
        .update(vaultItems)
        .set(set)
        .where(and(eq(vaultItems.id, id), eq(vaultItems.user_id, userId)))
        .returning();
      return row;
    },

    async touch(userId: string, id: string): Promise<void> {
      await db
        .update(vaultItems)
        .set({ last_used_at: nowIso() })
        .where(and(eq(vaultItems.id, id), eq(vaultItems.user_id, userId)));
    },

    async delete(userId: string, id: string): Promise<boolean> {
      const rows = await db
        .delete(vaultItems)
        .where(and(eq(vaultItems.id, id), eq(vaultItems.user_id, userId)))
        .returning({ id: vaultItems.id });
      return rows.length > 0;
    },

    async logAccess(input: VaultAccessInput): Promise<void> {
      await db.insert(vaultAccessLog).values({ ...input, created_at: nowIso() });
    },

    async listAccess(userId: string, limit = 100): Promise<VaultAccessLogRow[]> {
      return await db
        .select()
        .from(vaultAccessLog)
        .where(eq(vaultAccessLog.user_id, userId))
        .orderBy(desc(vaultAccessLog.created_at))
        .limit(limit);
    },
  };
}

export type VaultService = ReturnType<typeof createVaultService>;
