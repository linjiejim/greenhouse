/**
 * Session share service (PostgreSQL).
 *
 * Supports sharing sessions with specific users or the entire team ('__team__').
 * Per-user read tracking uses session_share_reads table (solves the team share bug
 * where a single read_at on __team__ rows would mark it read for everyone).
 */

import { eq, and, or, ne, desc, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import * as schema from '../schema/index.js';

export interface SessionShareRow {
  id: number;
  session_id: string;
  shared_with: string; // user_id or '__team__'
  shared_by: string;
  message: string | null;
  /** @deprecated Use per-user read tracking (session_share_reads). */
  read_at: string | null;
  created_at: string;
  /** Per-user read timestamp — populated by listForUser via LEFT JOIN. */
  user_read_at?: string | null;
}

export interface SessionShareInput {
  session_id: string;
  shared_with: string;
  shared_by: string;
  message?: string;
}

/** Summary of share info for a session from a viewer's perspective. */
export interface SessionShareInfo {
  shared_by: string;
  shared_by_nickname: string;
  message: string | null;
  created_at: string;
  total_viewers: number;
}

/** Sentinel value for "shared with entire team". */
const TEAM = '__team__';

export function createSessionShareService(db: Db) {
  const service = {
    async createMany(inputs: SessionShareInput[]): Promise<void> {
      if (inputs.length === 0) return;
      const now = nowIso();
      await db
        .insert(schema.sessionShares)
        .values(
          inputs.map((input) => ({
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
        .from(schema.sessionShares)
        .where(
          and(
            or(eq(schema.sessionShares.shared_with, userId), eq(schema.sessionShares.shared_with, TEAM)),
            // Exclude shares created by this user (don't notify yourself)
            ne(schema.sessionShares.shared_by, userId),
            // Exclude shares the user has already read (per-user tracking)
            sql`NOT EXISTS (
              SELECT 1 FROM session_share_reads ssr
              WHERE ssr.session_id = ${schema.sessionShares.session_id}
                AND ssr.user_id = ${userId}
            )`,
          ),
        );
      return row?.count ?? 0;
    },

    async listForUser(userId: string, opts?: { limit?: number; offset?: number }): Promise<SessionShareRow[]> {
      const limit = opts?.limit ?? 50;
      const offset = opts?.offset ?? 0;
      const rows = await db
        .select({
          id: schema.sessionShares.id,
          session_id: schema.sessionShares.session_id,
          shared_with: schema.sessionShares.shared_with,
          shared_by: schema.sessionShares.shared_by,
          message: schema.sessionShares.message,
          read_at: schema.sessionShares.read_at, // legacy, kept for compat
          created_at: schema.sessionShares.created_at,
          user_read_at: schema.sessionShareReads.read_at,
        })
        .from(schema.sessionShares)
        .leftJoin(
          schema.sessionShareReads,
          and(
            eq(schema.sessionShareReads.session_id, schema.sessionShares.session_id),
            eq(schema.sessionShareReads.user_id, userId),
          ),
        )
        .where(
          and(
            or(eq(schema.sessionShares.shared_with, userId), eq(schema.sessionShares.shared_with, TEAM)),
            // Exclude self-shared
            ne(schema.sessionShares.shared_by, userId),
          ),
        )
        .orderBy(
          // unread first: IS NOT NULL = false (0) for unread → sorts before true (1)
          sql`${schema.sessionShareReads.read_at} IS NOT NULL`,
          desc(schema.sessionShares.created_at),
        )
        .limit(limit)
        .offset(offset);

      return rows.map((r) => ({
        id: r.id,
        session_id: r.session_id,
        shared_with: r.shared_with,
        shared_by: r.shared_by,
        message: r.message,
        read_at: r.read_at, // legacy
        created_at: r.created_at,
        user_read_at: r.user_read_at,
      }));
    },

    async markReadForUser(shareId: number, userId: string): Promise<void> {
      // Look up session_id from the share row
      const [share] = await db
        .select({ session_id: schema.sessionShares.session_id })
        .from(schema.sessionShares)
        .where(eq(schema.sessionShares.id, shareId))
        .limit(1);
      if (!share) return;

      const now = nowIso();
      await db
        .insert(schema.sessionShareReads)
        .values({ session_id: share.session_id, user_id: userId, read_at: now })
        .onConflictDoNothing();
    },

    async markAllReadInSession(userId: string, sessionId: string): Promise<void> {
      const now = nowIso();
      // Upsert into per-user reads table
      await db
        .insert(schema.sessionShareReads)
        .values({ session_id: sessionId, user_id: userId, read_at: now })
        .onConflictDoNothing();
    },

    async markAllRead(userId: string): Promise<void> {
      // Find every session the user has a non-self share in, then upsert a
      // per-user read row for each. onConflictDoNothing keeps existing reads.
      const rows = await db
        .selectDistinct({ session_id: schema.sessionShares.session_id })
        .from(schema.sessionShares)
        .where(
          and(
            or(eq(schema.sessionShares.shared_with, userId), eq(schema.sessionShares.shared_with, TEAM)),
            ne(schema.sessionShares.shared_by, userId),
          ),
        );
      if (rows.length === 0) return;

      const now = nowIso();
      await db
        .insert(schema.sessionShareReads)
        .values(rows.map((r) => ({ session_id: r.session_id, user_id: userId, read_at: now })))
        .onConflictDoNothing();
    },

    async getSharedSessionIds(userId: string): Promise<string[]> {
      const rows = await db
        .selectDistinct({ session_id: schema.sessionShares.session_id })
        .from(schema.sessionShares)
        .where(or(eq(schema.sessionShares.shared_with, userId), eq(schema.sessionShares.shared_with, TEAM)));
      return rows.map((r) => r.session_id);
    },

    async getSharesForSession(sessionId: string): Promise<SessionShareRow[]> {
      return db
        .select()
        .from(schema.sessionShares)
        .where(eq(schema.sessionShares.session_id, sessionId))
        .orderBy(desc(schema.sessionShares.created_at));
    },

    async deleteForSession(sessionId: string): Promise<void> {
      // Clean up reads + shares
      await db.delete(schema.sessionShareReads).where(eq(schema.sessionShareReads.session_id, sessionId));
      await db.delete(schema.sessionShares).where(eq(schema.sessionShares.session_id, sessionId));
    },

    async deleteOne(id: number): Promise<void> {
      await db.delete(schema.sessionShares).where(eq(schema.sessionShares.id, id));
    },

    async getShareInfoForUser(sessionId: string, userId: string): Promise<SessionShareInfo | null> {
      // Get all shares for this session that are visible to this user
      const shares = await db
        .select()
        .from(schema.sessionShares)
        .where(
          and(
            eq(schema.sessionShares.session_id, sessionId),
            or(eq(schema.sessionShares.shared_with, userId), eq(schema.sessionShares.shared_with, TEAM)),
          ),
        )
        .orderBy(schema.sessionShares.created_at)
        .limit(1);

      if (shares.length === 0) return null;

      const share = shares[0];

      // Count total unique viewers (direct users + 1 for team if team-shared)
      const allShares = await db
        .select({
          shared_with: schema.sessionShares.shared_with,
        })
        .from(schema.sessionShares)
        .where(eq(schema.sessionShares.session_id, sessionId));

      let totalViewers = 0;
      for (const s of allShares) {
        if (s.shared_with === TEAM) {
          // Don't count __team__ as a number — it's dynamic
          totalViewers = -1; // signal: team-wide
          break;
        }
        totalViewers++;
      }

      return {
        shared_by: share.shared_by,
        shared_by_nickname: '', // filled by the route layer
        message: share.message,
        created_at: share.created_at,
        total_viewers: totalViewers, // -1 = team-wide
      };
    },
  };
  return service;
}

export type SessionShareService = ReturnType<typeof createSessionShareService>;
