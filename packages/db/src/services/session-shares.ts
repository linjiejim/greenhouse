/**
 * Session share service (PostgreSQL tables `conversation_shares` /
 * `conversation_share_reads`).
 *
 * Supports sharing sessions with specific users or the entire team ('__team__').
 * Per-user read tracking uses conversation_share_reads, so team shares are
 * tracked independently for every recipient. The same read row carries the
 * recipient's own pin (session-pins.ts), so a row may exist with read_at null.
 */

import { eq, and, or, ne, desc, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { newId } from '../ids.js';
import * as schema from '../schema/index.js';
import type { SessionShareRow } from '../schema/conversations.js';

export interface SessionInboxShareRow extends SessionShareRow {
  /** Per-user read timestamp populated by listForUser via LEFT JOIN. */
  read_at: string | null;
}

export interface SessionShareInput {
  session_id: string;
  shared_with: string;
  shared_by: string;
  message?: string;
}

/** Sentinel value for "shared with entire team". */
const TEAM = '__team__';

/**
 * Record that `userId` read these sessions. The read row may already exist
 * without a read time (the recipient pinned the share first) — fill it in then;
 * an existing read time is kept.
 */
async function upsertRead(db: Db, sessionIds: string[], userId: string, now: string): Promise<void> {
  if (sessionIds.length === 0) return;
  const reads = schema.conversationShareReads;
  await db
    .insert(reads)
    .values(
      sessionIds.map((sessionId) => ({
        id: newId('conversationShareRead'),
        session_id: sessionId,
        user_id: userId,
        read_at: now,
      })),
    )
    .onConflictDoUpdate({
      target: [reads.session_id, reads.user_id],
      set: { read_at: sql`coalesce(${reads.read_at}, excluded.read_at)` },
    });
}

export function createSessionShareService(db: Db) {
  const service = {
    async createMany(inputs: SessionShareInput[]): Promise<void> {
      if (inputs.length === 0) return;
      const now = nowIso();
      await db
        .insert(schema.conversationShares)
        .values(
          inputs.map((input) => ({
            id: newId('conversationShare'),
            session_id: input.session_id,
            shared_with: input.shared_with,
            shared_by: input.shared_by,
            message: input.message ?? null,
            created_at: now,
          })),
        )
        .onConflictDoNothing();
    },

    async countUnread(userId: string): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.conversationShares)
        .where(
          and(
            or(eq(schema.conversationShares.shared_with, userId), eq(schema.conversationShares.shared_with, TEAM)),
            // Exclude shares created by this user (don't notify yourself)
            ne(schema.conversationShares.shared_by, userId),
            // Exclude shares the user has already read (per-user tracking)
            sql`NOT EXISTS (
              SELECT 1 FROM ${schema.conversationShareReads} ssr
              WHERE ssr.session_id = ${schema.conversationShares.session_id}
                AND ssr.user_id = ${userId}
                AND ssr.read_at IS NOT NULL
            )`,
          ),
        );
      return row?.count ?? 0;
    },

    async listForUser(userId: string, opts?: { limit?: number; offset?: number }): Promise<SessionInboxShareRow[]> {
      const limit = opts?.limit ?? 50;
      const offset = opts?.offset ?? 0;
      const rows = await db
        .select({
          id: schema.conversationShares.id,
          session_id: schema.conversationShares.session_id,
          shared_with: schema.conversationShares.shared_with,
          shared_by: schema.conversationShares.shared_by,
          message: schema.conversationShares.message,
          created_at: schema.conversationShares.created_at,
          read_at: schema.conversationShareReads.read_at,
        })
        .from(schema.conversationShares)
        .leftJoin(
          schema.conversationShareReads,
          and(
            eq(schema.conversationShareReads.session_id, schema.conversationShares.session_id),
            eq(schema.conversationShareReads.user_id, userId),
          ),
        )
        .where(
          and(
            or(eq(schema.conversationShares.shared_with, userId), eq(schema.conversationShares.shared_with, TEAM)),
            // Exclude self-shared
            ne(schema.conversationShares.shared_by, userId),
          ),
        )
        .orderBy(
          // unread first: IS NOT NULL = false (0) for unread → sorts before true (1)
          sql`${schema.conversationShareReads.read_at} IS NOT NULL`,
          desc(schema.conversationShares.created_at),
        )
        .limit(limit)
        .offset(offset);

      return rows;
    },

    async markReadForUser(shareId: string, userId: string): Promise<boolean> {
      // Resolve only a share actually addressed to this user. Without this
      // predicate, knowing another share id lets a user create arbitrary read
      // receipts for sessions outside their inbox.
      const [share] = await db
        .select({ session_id: schema.conversationShares.session_id })
        .from(schema.conversationShares)
        .where(
          and(
            eq(schema.conversationShares.id, shareId),
            or(eq(schema.conversationShares.shared_with, userId), eq(schema.conversationShares.shared_with, TEAM)),
            ne(schema.conversationShares.shared_by, userId),
          ),
        )
        .limit(1);
      if (!share) return false;

      const now = nowIso();
      await upsertRead(db, [share.session_id], userId, now);
      return true;
    },

    async markAllReadInSession(userId: string, sessionId: string): Promise<boolean> {
      const [share] = await db
        .select({ id: schema.conversationShares.id })
        .from(schema.conversationShares)
        .where(
          and(
            eq(schema.conversationShares.session_id, sessionId),
            or(eq(schema.conversationShares.shared_with, userId), eq(schema.conversationShares.shared_with, TEAM)),
            ne(schema.conversationShares.shared_by, userId),
          ),
        )
        .limit(1);
      if (!share) return false;

      const now = nowIso();
      await upsertRead(db, [sessionId], userId, now);
      return true;
    },

    async markAllRead(userId: string): Promise<void> {
      // Find every session the user has a non-self share in, then upsert a
      // per-user read row for each; an earlier read time is kept.
      const rows = await db
        .selectDistinct({ session_id: schema.conversationShares.session_id })
        .from(schema.conversationShares)
        .where(
          and(
            or(eq(schema.conversationShares.shared_with, userId), eq(schema.conversationShares.shared_with, TEAM)),
            ne(schema.conversationShares.shared_by, userId),
          ),
        );
      if (rows.length === 0) return;

      const now = nowIso();
      await upsertRead(
        db,
        rows.map((r) => r.session_id),
        userId,
        now,
      );
    },

    async getSharedSessionIds(userId: string): Promise<string[]> {
      const rows = await db
        .selectDistinct({ session_id: schema.conversationShares.session_id })
        .from(schema.conversationShares)
        .where(or(eq(schema.conversationShares.shared_with, userId), eq(schema.conversationShares.shared_with, TEAM)));
      return rows.map((r) => r.session_id);
    },

    async getSharesForSession(sessionId: string): Promise<SessionShareRow[]> {
      return db
        .select()
        .from(schema.conversationShares)
        .where(eq(schema.conversationShares.session_id, sessionId))
        .orderBy(desc(schema.conversationShares.created_at));
    },

    async deleteForSession(sessionId: string): Promise<void> {
      // Clean up reads + shares
      await db.delete(schema.conversationShareReads).where(eq(schema.conversationShareReads.session_id, sessionId));
      await db.delete(schema.conversationShares).where(eq(schema.conversationShares.session_id, sessionId));
    },

    async deleteOne(id: string, sessionId: string): Promise<boolean> {
      const rows = await db
        .delete(schema.conversationShares)
        .where(and(eq(schema.conversationShares.id, id), eq(schema.conversationShares.session_id, sessionId)))
        .returning({ id: schema.conversationShares.id });
      return rows.length > 0;
    },
  };
  return service;
}

export type SessionShareService = ReturnType<typeof createSessionShareService>;
