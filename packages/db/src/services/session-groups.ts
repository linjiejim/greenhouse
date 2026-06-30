/**
 * Session group service — per-user session folders + Pinned (PostgreSQL).
 *
 * Folders are single-home (a session lives in at most one custom group per
 * user — enforced here in `setSessionGroup`). Pinned is a built-in system
 * group (`kind = 'pinned'`, auto-provisioned per user) and is cross-cutting,
 * so a session can be both pinned and in one folder.
 *
 * Membership rows carry `user_id`, so every user's organization is private and
 * independent — including over sessions shared to them by someone else.
 */

import { eq, and, asc, desc, inArray, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { sessionGroups, sessionGroupMembers } from '../schema/index.js';
import type { SessionGroupRow } from '../schema/session-group.js';

export const PINNED_GROUP_KIND = 'pinned';
export const CUSTOM_GROUP_KIND = 'custom';
const PINNED_GROUP_NAME = 'Pinned';

export interface SessionGroupInput {
  user_id: string;
  name: string;
  color?: string;
  icon?: string;
  sort_order?: number;
}

export interface SessionGroupUpdateInput {
  name?: string;
  color?: string;
  icon?: string;
  sort_order?: number;
}

/** Per-session membership snapshot for the current user (drives list enrichment). */
export interface SessionMembership {
  group_id: number | null;
  group_sort: number;
  pinned: boolean;
  pin_sort: number;
}

export function createSessionGroupService(db: Db) {
  const service = {
    // ─── Group CRUD ──────────────────────────────────────

    async listByUser(userId: string): Promise<SessionGroupRow[]> {
      return await db
        .select()
        .from(sessionGroups)
        .where(eq(sessionGroups.user_id, userId))
        .orderBy(asc(sessionGroups.sort_order), asc(sessionGroups.id));
    },

    async getById(id: number): Promise<SessionGroupRow | undefined> {
      const rows = await db.select().from(sessionGroups).where(eq(sessionGroups.id, id));
      return rows[0];
    },

    async create(input: SessionGroupInput): Promise<SessionGroupRow> {
      const now = nowIso();
      const rows = await db
        .insert(sessionGroups)
        .values({
          user_id: input.user_id,
          name: input.name,
          color: input.color ?? '#6B7280',
          icon: input.icon ?? null,
          kind: CUSTOM_GROUP_KIND,
          sort_order: input.sort_order ?? 0,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return rows[0]!;
    },

    async update(id: number, updates: SessionGroupUpdateInput): Promise<SessionGroupRow | undefined> {
      const rows = await db
        .update(sessionGroups)
        .set({ ...updates, updated_at: nowIso() })
        .where(eq(sessionGroups.id, id))
        .returning();
      return rows[0];
    },

    async delete(id: number): Promise<boolean> {
      // Members cascade via FK (onDelete: 'cascade').
      const result = await db.delete(sessionGroups).where(eq(sessionGroups.id, id)).returning();
      return result.length > 0;
    },

    async reorder(updates: Array<{ id: number; sort_order: number }>): Promise<void> {
      const now = nowIso();
      await Promise.all(
        updates.map((u) =>
          db.update(sessionGroups).set({ sort_order: u.sort_order, updated_at: now }).where(eq(sessionGroups.id, u.id)),
        ),
      );
    },

    // ─── Pinned (system group) ───────────────────────────

    /** Lazily provision (or fetch) this user's built-in Pinned group. */
    async getOrCreatePinnedGroup(userId: string): Promise<SessionGroupRow> {
      const existing = (await service.listByUser(userId)).find((g) => g.kind === PINNED_GROUP_KIND);
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
            kind: PINNED_GROUP_KIND,
            sort_order: -1, // floats above custom folders (which start at 0)
            created_at: now,
            updated_at: now,
          })
          .returning();
        return rows[0]!;
      } catch (err: any) {
        // Name collision with a user folder also named "Pinned" — re-fetch.
        if (err?.code === '23505' || err?.message?.includes('unique')) {
          const again = (await service.listByUser(userId)).find((g) => g.kind === PINNED_GROUP_KIND);
          if (again) return again;
        }
        throw err;
      }
    },

    async pin(userId: string, sessionId: string): Promise<void> {
      const pinned = await service.getOrCreatePinnedGroup(userId);
      const sort = (await service.maxMemberSort(pinned.id)) + 1;
      await db
        .insert(sessionGroupMembers)
        .values({
          user_id: userId,
          group_id: pinned.id,
          session_id: sessionId,
          kind: PINNED_GROUP_KIND,
          sort_order: sort,
          created_at: nowIso(),
        })
        .onConflictDoNothing();
    },

    async unpin(userId: string, sessionId: string): Promise<void> {
      const pinned = (await service.listByUser(userId)).find((g) => g.kind === PINNED_GROUP_KIND);
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

    // ─── Folder membership (single-home) ─────────────────

    /**
     * Set (or clear, with groupId=null) the session's custom folder for this
     * user. Single-home: any existing custom membership is removed first.
     * Does NOT touch the pinned membership. Returns false if groupId is given
     * but is not one of the user's custom groups.
     */
    async setSessionGroup(userId: string, sessionId: string, groupId: number | null): Promise<boolean> {
      const groups = await service.listByUser(userId);
      const customIds = groups.filter((g) => g.kind === CUSTOM_GROUP_KIND).map((g) => g.id);

      if (customIds.length > 0) {
        await db
          .delete(sessionGroupMembers)
          .where(
            and(
              eq(sessionGroupMembers.user_id, userId),
              eq(sessionGroupMembers.session_id, sessionId),
              inArray(sessionGroupMembers.group_id, customIds),
            ),
          );
      }

      if (groupId == null) return true;

      const target = groups.find((g) => g.id === groupId && g.kind === CUSTOM_GROUP_KIND);
      if (!target) return false;

      const sort = (await service.maxMemberSort(groupId)) + 1;
      await db
        .insert(sessionGroupMembers)
        .values({
          user_id: userId,
          group_id: groupId,
          session_id: sessionId,
          kind: CUSTOM_GROUP_KIND,
          sort_order: sort,
          created_at: nowIso(),
        })
        .onConflictDoNothing();
      return true;
    },

    async maxMemberSort(groupId: number): Promise<number> {
      const rows = await db
        .select({ sort_order: sessionGroupMembers.sort_order })
        .from(sessionGroupMembers)
        .where(eq(sessionGroupMembers.group_id, groupId))
        .orderBy(desc(sessionGroupMembers.sort_order))
        .limit(1);
      return rows[0]?.sort_order ?? -1;
    },

    /** Reorder sessions within one group (Pinned or a folder). */
    async reorderMembers(
      userId: string,
      groupId: number,
      updates: Array<{ session_id: string; sort_order: number }>,
    ): Promise<void> {
      await Promise.all(
        updates.map((u) =>
          db
            .update(sessionGroupMembers)
            .set({ sort_order: u.sort_order })
            .where(
              and(
                eq(sessionGroupMembers.user_id, userId),
                eq(sessionGroupMembers.group_id, groupId),
                eq(sessionGroupMembers.session_id, u.session_id),
              ),
            ),
        ),
      );
    },

    // ─── List enrichment helpers ─────────────────────────

    /** Distinct session ids the user has pinned or filed in any folder. */
    async getOrganizedSessionIds(userId: string): Promise<string[]> {
      const rows = await db
        .selectDistinct({ session_id: sessionGroupMembers.session_id })
        .from(sessionGroupMembers)
        .where(eq(sessionGroupMembers.user_id, userId));
      return rows.map((r) => r.session_id);
    },

    /** Collapse this user's memberships for the given sessions into one row each. */
    async getMembershipsForUser(userId: string, sessionIds: string[]): Promise<Map<string, SessionMembership>> {
      if (sessionIds.length === 0) return new Map();
      const rows = await db
        .select({
          session_id: sessionGroupMembers.session_id,
          group_id: sessionGroupMembers.group_id,
          sort_order: sessionGroupMembers.sort_order,
          kind: sessionGroups.kind,
        })
        .from(sessionGroupMembers)
        .innerJoin(sessionGroups, eq(sessionGroupMembers.group_id, sessionGroups.id))
        .where(and(eq(sessionGroupMembers.user_id, userId), inArray(sessionGroupMembers.session_id, sessionIds)));

      const map = new Map<string, SessionMembership>();
      for (const r of rows) {
        const cur = map.get(r.session_id) ?? { group_id: null, group_sort: 0, pinned: false, pin_sort: 0 };
        if (r.kind === PINNED_GROUP_KIND) {
          cur.pinned = true;
          cur.pin_sort = r.sort_order;
        } else {
          cur.group_id = r.group_id;
          cur.group_sort = r.sort_order;
        }
        map.set(r.session_id, cur);
      }
      return map;
    },

    /** Member counts per group for the user (drives sidebar section counts). */
    async getMemberCounts(userId: string): Promise<Map<number, number>> {
      const rows = await db
        .select({ group_id: sessionGroupMembers.group_id, count: sql<number>`count(*)::int` })
        .from(sessionGroupMembers)
        .where(eq(sessionGroupMembers.user_id, userId))
        .groupBy(sessionGroupMembers.group_id);
      const map = new Map<number, number>();
      for (const r of rows) map.set(r.group_id, Number(r.count));
      return map;
    },
  };
  return service;
}

export type SessionGroupService = ReturnType<typeof createSessionGroupService>;
