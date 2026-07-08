/**
 * IM gateway service — bots, linked identities, and pairing codes (PostgreSQL).
 *
 * See packages/db/src/schema/im.ts for the table shapes and the M0 (Telegram)
 * design. Token encryption is done by the caller (apps/api auth/crypto.ts) —
 * `token_enc` is stored/returned verbatim here.
 */

import { randomUUID } from 'node:crypto';
import { eq, and, lt } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { imBots, imIdentities, imPairingCodes } from '../schema/index.js';
import type { ImBotRow, ImBotStatus, ImChannel, ImIdentityRow, ImPairingCodeRow } from '../schema/im.js';

export interface ImBotInput {
  id: string;
  channel?: ImChannel;
  name: string;
  token_enc: string;
  bot_username?: string | null;
  default_profile_id?: string;
  created_by?: string;
}

export interface ImBotUpdateInput {
  name?: string;
  status?: ImBotStatus;
  default_profile_id?: string;
  token_enc?: string;
  bot_username?: string | null;
}

export interface ImLinkInput {
  bot_id: string;
  channel?: ImChannel;
  ext_user_id: string;
  ext_chat_id: string;
  user_id: string;
  display_name?: string | null;
}

/** IM gateway CRUD: bots, identities, pairing codes. */
export function createImService(db: Db) {
  const service = {
    // ─── Bots ─────────────────────────────────────────────
    async createBot(input: ImBotInput): Promise<ImBotRow> {
      const now = nowIso();
      await db.insert(imBots).values({
        id: input.id,
        channel: input.channel ?? 'telegram',
        name: input.name.trim(),
        token_enc: input.token_enc,
        bot_username: input.bot_username ?? null,
        default_profile_id: input.default_profile_id ?? 'default',
        status: 'active',
        poll_offset: 0,
        created_by: input.created_by ?? null,
        created_at: now,
        updated_at: now,
      });
      const rows = await db.select().from(imBots).where(eq(imBots.id, input.id));
      return rows[0]!;
    },

    async getBot(id: string): Promise<ImBotRow | undefined> {
      const rows = await db.select().from(imBots).where(eq(imBots.id, id));
      return rows[0];
    },

    async listBots(): Promise<ImBotRow[]> {
      return await db.select().from(imBots).orderBy(imBots.created_at);
    },

    async listActiveBots(): Promise<ImBotRow[]> {
      return await db.select().from(imBots).where(eq(imBots.status, 'active')).orderBy(imBots.created_at);
    },

    async updateBot(id: string, updates: ImBotUpdateInput): Promise<ImBotRow | undefined> {
      const set: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.name !== undefined) set.name = updates.name.trim();
      if (updates.status !== undefined) set.status = updates.status;
      if (updates.default_profile_id !== undefined) set.default_profile_id = updates.default_profile_id;
      if (updates.token_enc !== undefined) set.token_enc = updates.token_enc;
      if (updates.bot_username !== undefined) set.bot_username = updates.bot_username;
      await db.update(imBots).set(set).where(eq(imBots.id, id));
      return service.getBot(id);
    },

    /** Persist the Telegram long-poll cursor (does NOT bump updated_at — it's a hot path). */
    async setPollOffset(id: string, offset: number): Promise<void> {
      await db.update(imBots).set({ poll_offset: offset }).where(eq(imBots.id, id));
    },

    async deleteBot(id: string): Promise<boolean> {
      const deleted = await db.delete(imBots).where(eq(imBots.id, id)).returning({ id: imBots.id });
      return deleted.length > 0;
    },

    // ─── Identities ───────────────────────────────────────
    async getIdentity(botId: string, extUserId: string): Promise<ImIdentityRow | undefined> {
      const rows = await db
        .select()
        .from(imIdentities)
        .where(and(eq(imIdentities.bot_id, botId), eq(imIdentities.ext_user_id, extUserId)));
      return rows[0];
    },

    async getIdentityById(id: string): Promise<ImIdentityRow | undefined> {
      const rows = await db.select().from(imIdentities).where(eq(imIdentities.id, id));
      return rows[0];
    },

    async listIdentitiesByUser(userId: string): Promise<ImIdentityRow[]> {
      return await db
        .select()
        .from(imIdentities)
        .where(eq(imIdentities.user_id, userId))
        .orderBy(imIdentities.created_at);
    },

    /**
     * Create or re-point a linked identity. If a link already exists for
     * (bot, ext_user), it is re-pointed to `user_id` and its bound session is
     * reset when the owner changes (so one user's conversation never leaks to
     * another after a re-pair).
     */
    async upsertLink(input: ImLinkInput): Promise<ImIdentityRow> {
      const now = nowIso();
      const existing = await service.getIdentity(input.bot_id, input.ext_user_id);
      if (existing) {
        const ownerChanged = existing.user_id !== input.user_id;
        await db
          .update(imIdentities)
          .set({
            user_id: input.user_id,
            ext_chat_id: input.ext_chat_id,
            display_name: input.display_name ?? existing.display_name,
            session_id: ownerChanged ? null : existing.session_id,
            updated_at: now,
          })
          .where(eq(imIdentities.id, existing.id));
        return (await service.getIdentityById(existing.id))!;
      }
      const id = `imid-${randomUUID().slice(0, 8)}`;
      await db.insert(imIdentities).values({
        id,
        bot_id: input.bot_id,
        channel: input.channel ?? 'telegram',
        ext_user_id: input.ext_user_id,
        ext_chat_id: input.ext_chat_id,
        user_id: input.user_id,
        session_id: null,
        display_name: input.display_name ?? null,
        created_at: now,
        updated_at: now,
      });
      return (await service.getIdentityById(id))!;
    },

    async setIdentitySession(id: string, sessionId: string | null): Promise<void> {
      await db.update(imIdentities).set({ session_id: sessionId, updated_at: nowIso() }).where(eq(imIdentities.id, id));
    },

    async deleteIdentity(id: string): Promise<boolean> {
      const deleted = await db.delete(imIdentities).where(eq(imIdentities.id, id)).returning({ id: imIdentities.id });
      return deleted.length > 0;
    },

    // ─── Pairing codes ────────────────────────────────────
    async createPairingCode(input: {
      code: string;
      bot_id: string;
      user_id: string;
      expires_at: string;
    }): Promise<ImPairingCodeRow> {
      const now = nowIso();
      // Invalidate any outstanding codes for this (user, bot) so codes don't pile up.
      await db
        .delete(imPairingCodes)
        .where(and(eq(imPairingCodes.user_id, input.user_id), eq(imPairingCodes.bot_id, input.bot_id)));
      await db.insert(imPairingCodes).values({
        code: input.code,
        bot_id: input.bot_id,
        user_id: input.user_id,
        expires_at: input.expires_at,
        created_at: now,
      });
      const rows = await db.select().from(imPairingCodes).where(eq(imPairingCodes.code, input.code));
      return rows[0]!;
    },

    async getPairingCode(code: string): Promise<ImPairingCodeRow | undefined> {
      const rows = await db.select().from(imPairingCodes).where(eq(imPairingCodes.code, code));
      return rows[0];
    },

    async deletePairingCode(code: string): Promise<void> {
      await db.delete(imPairingCodes).where(eq(imPairingCodes.code, code));
    },

    /** Sweep expired pairing codes (called periodically by the gateway). */
    async deleteExpiredPairingCodes(): Promise<number> {
      const deleted = await db
        .delete(imPairingCodes)
        .where(lt(imPairingCodes.expires_at, nowIso()))
        .returning({ code: imPairingCodes.code });
      return deleted.length;
    },
  };
  return service;
}

export type ImService = ReturnType<typeof createImService>;
