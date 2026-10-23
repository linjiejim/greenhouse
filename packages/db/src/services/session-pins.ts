/**
 * Session pin service — per-user pinned conversations (PostgreSQL).
 *
 * Pins live in the `session_groups` / `session_group_members` tables as a
 * built-in system group (`kind = 'pinned'`, auto-provisioned per user). Custom
 * folders (`kind = 'custom'`) were removed in 1.5; their rows stay in the same
 * tables untouched, and every query here is scoped to the user's Pinned group.
 *
 * Membership rows carry `user_id`, so every user's pins are private and
 * independent — including on sessions shared to them by someone else.
 */

import { eq, and, desc, inArray } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import { isUniqueViolation } from '@greenhouse/utils/error';

import type { Db } from '../client.js';
import { sessionGroups, sessionGroupMembers } from '../schema/index.js';
import type { SessionGroupRow } from '../schema/session-group.js';

const PINNED_KIND = 'pinned';
const PINNED_GROUP_NAME = 'Pinned';

export function createSessionPinService(db: Db) {
  async function findPinnedGroup(userId: string): Promise<SessionGroupRow | undefined> {
    const rows = await db
      .select()
      .from(sessionGroups)
      .where(and(eq(sessionGroups.user_id, userId), eq(sessionGroups.kind, PINNED_KIND)))
      .limit(1);
    return rows[0];
  }

  /** Lazily provision (or fetch) this user's built-in Pinned group. */
  async function getOrCreatePinnedGroup(userId: string): Promise<SessionGroupRow> {
    const existing = await findPinnedGroup(userId);
    if (existing) return existing;
    const now = nowIso();
    try {
      const rows = await db
        .insert(sessionGroups)
        .values({
          user_id: userId,
          name: PINNED_GROUP_NAME,
          color: '#F59E0B',
          icon: 'pin',
          kind: PINNED_KIND,
          sort_order: -1,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return rows[0]!;
    } catch (err) {
      // A concurrent pin provisioned it first, or a legacy folder is named "Pinned".
      if (isUniqueViolation(err)) {
        const again = await findPinnedGroup(userId);
        if (again) return again;
      }
      throw err;
    }
  }

  async function maxPinSort(groupId: number): Promise<number> {
    const rows = await db
      .select({ sort_order: sessionGroupMembers.sort_order })
      .from(sessionGroupMembers)
      .where(eq(sessionGroupMembers.group_id, groupId))
      .orderBy(desc(sessionGroupMembers.sort_order))
      .limit(1);
    return rows[0]?.sort_order ?? -1;
  }

  return {
    async pin(userId: string, sessionId: string): Promise<void> {
      const pinned = await getOrCreatePinnedGroup(userId);
      const sort = (await maxPinSort(pinned.id)) + 1;
      await db
        .insert(sessionGroupMembers)
        .values({
          user_id: userId,
          group_id: pinned.id,
          session_id: sessionId,
          kind: PINNED_KIND,
          sort_order: sort,
          created_at: nowIso(),
        })
        .onConflictDoNothing();
    },

    async unpin(userId: string, sessionId: string): Promise<void> {
      const pinned = await findPinnedGroup(userId);
      if (!pinned) return;
      await db
        .delete(sessionGroupMembers)
        .where(
          and(
            eq(sessionGroupMembers.user_id, userId),
            eq(sessionGroupMembers.group_id, pinned.id),
            eq(sessionGroupMembers.session_id, sessionId),
          ),
        );
    },

    /** Reorder the user's pinned sessions. Ids that are not pinned are ignored. */
    async reorder(userId: string, updates: Array<{ session_id: string; sort_order: number }>): Promise<void> {
      const pinned = await findPinnedGroup(userId);
      if (!pinned) return;
      await Promise.all(
        updates.map((u) =>
          db
            .update(sessionGroupMembers)
            .set({ sort_order: u.sort_order })
            .where(
              and(
                eq(sessionGroupMembers.user_id, userId),
                eq(sessionGroupMembers.group_id, pinned.id),
                eq(sessionGroupMembers.session_id, u.session_id),
              ),
            ),
        ),
      );
    },

    /** Session ids the user has pinned. */
    async getPinnedSessionIds(userId: string): Promise<string[]> {
      const pinned = await findPinnedGroup(userId);
      if (!pinned) return [];
      const rows = await db
        .select({ session_id: sessionGroupMembers.session_id })
        .from(sessionGroupMembers)
        .where(and(eq(sessionGroupMembers.user_id, userId), eq(sessionGroupMembers.group_id, pinned.id)));
      return rows.map((r) => r.session_id);
    },

    /** Pin sort order per pinned session among `sessionIds`; unpinned sessions are absent. */
    async getPinSortsForUser(userId: string, sessionIds: string[]): Promise<Map<string, number>> {
      if (sessionIds.length === 0) return new Map();
      const pinned = await findPinnedGroup(userId);
      if (!pinned) return new Map();
      const rows = await db
        .select({ session_id: sessionGroupMembers.session_id, sort_order: sessionGroupMembers.sort_order })
        .from(sessionGroupMembers)
        .where(
          and(
            eq(sessionGroupMembers.user_id, userId),
            eq(sessionGroupMembers.group_id, pinned.id),
            inArray(sessionGroupMembers.session_id, sessionIds),
          ),
        );
      return new Map(rows.map((r) => [r.session_id, r.sort_order]));
    },
  };
}

export type SessionPinService = ReturnType<typeof createSessionPinService>;
