/**
 * Group service — user-created groups used as sharing targets (PostgreSQL).
 *
 * A group is owned by created_by; membership is managed by the owner (or
 * super). listForUser returns groups the user owns or belongs to.
 */

import { eq, and, or, inArray, desc, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { userGroups, groupMembers } from '../schema/index.js';
import type { UserGroupRow, GroupMemberRow } from '../schema/groups.js';

export function createGroupService(db: Db) {
  const service = {
    async create(input: { name: string; description?: string | null; created_by: string }): Promise<UserGroupRow> {
      const now = nowIso();
      const rows = await db
        .insert(userGroups)
        .values({
          name: input.name,
          description: input.description ?? null,
          created_by: input.created_by,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return rows[0];
    },

    async update(
      id: number,
      updates: { name?: string; description?: string | null },
    ): Promise<UserGroupRow | undefined> {
      const set: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.name !== undefined) set.name = updates.name;
      if (updates.description !== undefined) set.description = updates.description;
      const rows = await db.update(userGroups).set(set).where(eq(userGroups.id, id)).returning();
      return rows[0];
    },

    async delete(id: number): Promise<boolean> {
      const rows = await db.delete(userGroups).where(eq(userGroups.id, id)).returning({ id: userGroups.id });
      return rows.length > 0;
    },

    async getById(id: number): Promise<UserGroupRow | undefined> {
      const rows = await db.select().from(userGroups).where(eq(userGroups.id, id)).limit(1);
      return rows[0];
    },

    /** Groups the user owns or is a member of. */
    async listForUser(userId: string): Promise<UserGroupRow[]> {
      // Groups the user created OR is a member of.
      const memberGroupIds = db
        .select({ id: groupMembers.group_id })
        .from(groupMembers)
        .where(eq(groupMembers.user_id, userId));
      return db
        .select()
        .from(userGroups)
        .where(or(eq(userGroups.created_by, userId), inArray(userGroups.id, memberGroupIds)))
        .orderBy(desc(userGroups.updated_at));
    },

    /** All groups (super/admin views). */
    async listAll(): Promise<UserGroupRow[]> {
      return db.select().from(userGroups).orderBy(desc(userGroups.updated_at));
    },

    async addMembers(groupId: number, userIds: string[], addedBy: string): Promise<void> {
      if (userIds.length === 0) return;
      const now = nowIso();
      await db
        .insert(groupMembers)
        .values(userIds.map((uid) => ({ group_id: groupId, user_id: uid, added_by: addedBy, created_at: now })))
        .onConflictDoNothing({ target: [groupMembers.group_id, groupMembers.user_id] });
    },

    async removeMember(groupId: number, userId: string): Promise<boolean> {
      const rows = await db
        .delete(groupMembers)
        .where(and(eq(groupMembers.group_id, groupId), eq(groupMembers.user_id, userId)))
        .returning({ id: groupMembers.id });
      return rows.length > 0;
    },

    async listMembers(groupId: number): Promise<GroupMemberRow[]> {
      return db
        .select()
        .from(groupMembers)
        .where(eq(groupMembers.group_id, groupId))
        .orderBy(desc(groupMembers.created_at));
    },

    async isMember(groupId: number, userId: string): Promise<boolean> {
      const rows = await db.execute(sql`
        SELECT 1 FROM group_members WHERE group_id = ${groupId} AND user_id = ${userId} LIMIT 1
      `);
      return (rows as unknown as unknown[]).length > 0;
    },
  };
  return service;
}

export type GroupService = ReturnType<typeof createGroupService>;
