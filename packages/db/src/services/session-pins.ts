/**
 * Session pin service — per-user pinned conversations (PostgreSQL).
 *
 * A pin lives where the pinning person's state on the conversation lives:
 * the owner pins on `conversations` (`pinned_at` / `pin_position`); anyone
 * else — the recipient of a share — pins on their own
 * `conversation_share_reads` row, which is upserted (its `read_at` may stay
 * null). Every user's pins are therefore private and independent.
 *
 * `pin_position` orders one user's pins ascending across both places; a new pin
 * goes after the user's last one.
 */

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { newId } from '../ids.js';
import { conversations, conversationShareReads } from '../schema/index.js';

export function createSessionPinService(db: Db) {
  /** Whether `userId` owns the conversation; undefined when it does not exist. */
  async function ownsSession(userId: string, sessionId: string): Promise<boolean | undefined> {
    const [row] = await db
      .select({ user_id: conversations.user_id })
      .from(conversations)
      .where(eq(conversations.id, sessionId))
      .limit(1);
    if (!row) return undefined;
    return row.user_id === userId;
  }

  async function nextPinPosition(userId: string): Promise<number> {
    const rows = await db.execute<{ max: number | null }>(sql`
      SELECT max(pos)::int AS max FROM (
        SELECT ${conversations.pin_position} AS pos FROM ${conversations}
        WHERE ${conversations.user_id} = ${userId} AND ${conversations.pinned_at} IS NOT NULL
        UNION ALL
        SELECT ${conversationShareReads.pin_position} AS pos FROM ${conversationShareReads}
        WHERE ${conversationShareReads.user_id} = ${userId} AND ${conversationShareReads.pinned_at} IS NOT NULL
      ) pins
    `);
    const max = rows[0]?.max;
    return max == null ? 0 : Number(max) + 1;
  }

  /** Pinned session ids (with positions) of this user, optionally narrowed to `sessionIds`. */
  async function pinsOf(
    userId: string,
    sessionIds?: string[],
  ): Promise<Array<{ session_id: string; position: number }>> {
    const owned = await db
      .select({ session_id: conversations.id, position: conversations.pin_position })
      .from(conversations)
      .where(
        and(
          eq(conversations.user_id, userId),
          isNotNull(conversations.pinned_at),
          ...(sessionIds ? [inArray(conversations.id, sessionIds)] : []),
        ),
      );
    const received = await db
      .select({ session_id: conversationShareReads.session_id, position: conversationShareReads.pin_position })
      .from(conversationShareReads)
      .where(
        and(
          eq(conversationShareReads.user_id, userId),
          isNotNull(conversationShareReads.pinned_at),
          ...(sessionIds ? [inArray(conversationShareReads.session_id, sessionIds)] : []),
        ),
      );
    return [...owned, ...received];
  }

  return {
    /** Pin a conversation for this user; pinning an already pinned one is a no-op. */
    async pin(userId: string, sessionId: string): Promise<void> {
      const owner = await ownsSession(userId, sessionId);
      if (owner === undefined) return;
      const position = await nextPinPosition(userId);
      const now = nowIso();
      if (owner) {
        await db
          .update(conversations)
          .set({ pinned_at: now, pin_position: position })
          .where(and(eq(conversations.id, sessionId), sql`${conversations.pinned_at} IS NULL`));
        return;
      }
      await db
        .insert(conversationShareReads)
        .values({
          id: newId('conversationShareRead'),
          session_id: sessionId,
          user_id: userId,
          read_at: null,
          pinned_at: now,
          pin_position: position,
        })
        .onConflictDoUpdate({
          target: [conversationShareReads.session_id, conversationShareReads.user_id],
          set: { pinned_at: now, pin_position: position },
          setWhere: sql`${conversationShareReads.pinned_at} IS NULL`,
        });
    },

    async unpin(userId: string, sessionId: string): Promise<void> {
      await db
        .update(conversations)
        .set({ pinned_at: null, pin_position: 0 })
        .where(and(eq(conversations.id, sessionId), eq(conversations.user_id, userId)));
      await db
        .update(conversationShareReads)
        .set({ pinned_at: null, pin_position: 0 })
        .where(and(eq(conversationShareReads.session_id, sessionId), eq(conversationShareReads.user_id, userId)));
    },

    /** Reorder the user's pinned sessions. Ids that are not pinned are ignored. */
    async reorder(userId: string, updates: Array<{ session_id: string; sort_order: number }>): Promise<void> {
      await Promise.all(
        updates.flatMap((u) => [
          db
            .update(conversations)
            .set({ pin_position: u.sort_order })
            .where(
              and(
                eq(conversations.id, u.session_id),
                eq(conversations.user_id, userId),
                isNotNull(conversations.pinned_at),
              ),
            ),
          db
            .update(conversationShareReads)
            .set({ pin_position: u.sort_order })
            .where(
              and(
                eq(conversationShareReads.session_id, u.session_id),
                eq(conversationShareReads.user_id, userId),
                isNotNull(conversationShareReads.pinned_at),
              ),
            ),
        ]),
      );
    },

    /** Session ids the user has pinned. */
    async getPinnedSessionIds(userId: string): Promise<string[]> {
      return (await pinsOf(userId)).map((pin) => pin.session_id);
    },

    /** Pin sort order per pinned session among `sessionIds`; unpinned sessions are absent. */
    async getPinSortsForUser(userId: string, sessionIds: string[]): Promise<Map<string, number>> {
      if (sessionIds.length === 0) return new Map();
      return new Map((await pinsOf(userId, sessionIds)).map((pin) => [pin.session_id, pin.position]));
    },
  };
}

export type SessionPinService = ReturnType<typeof createSessionPinService>;
