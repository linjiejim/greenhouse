/**
 * Base membership rows. Effective-role resolution (owner / member / group /
 * team default, custom roles) lives in the API's `platform/tables/access.ts`;
 * the db layer only stores and reads the grants.
 */

import { and, asc, eq } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import { resolveCapability } from '@greenhouse/platform-kernel';
import type { TableBaseRole } from '@greenhouse/types/tables';
import type { Db } from '../../client.js';
import { tableBaseMembers, tableBases, users } from '../../schema/index.js';
import type { TableBaseMemberRow } from '../../schema/tables.js';
import { createPlatformService } from '../platform.js';

export function createTablesMembers(db: Db) {
  const platform = createPlatformService(db);

  /**
   * Can this user edit records of the Base (the automation executor check)?
   * Built-in roles only: a custom role never qualifies here.
   */
  const canUserEditBase = async (baseId: number, userId: string): Promise<boolean> => {
    const [user, base, member, authorization] = await Promise.all([
      db.select().from(users).where(eq(users.id, userId)).limit(1),
      db.select().from(tableBases).where(eq(tableBases.id, baseId)).limit(1),
      db
        .select()
        .from(tableBaseMembers)
        .where(and(eq(tableBaseMembers.base_id, baseId), eq(tableBaseMembers.user_id, userId)))
        .limit(1),
      platform.getAuthorizationSnapshot(userId, 'default'),
    ]);
    if (
      !user[0] ||
      user[0].status !== 'active' ||
      (user[0].role !== 'team' && user[0].role !== 'super') ||
      !base[0] ||
      base[0].archived_at
    ) {
      return false;
    }
    if (!resolveCapability({ capability: 'tables.data.update', ...authorization }).allowed) return false;
    if (user[0].role === 'super' || base[0].owner_id === user[0].id) return true;
    return member[0]?.role === 'owner' || member[0]?.role === 'builder' || member[0]?.role === 'editor';
  };

  return {
    canUserEditBase,

    async getBaseMember(baseId: number, userId: string): Promise<TableBaseMemberRow | undefined> {
      const rows = await db
        .select()
        .from(tableBaseMembers)
        .where(and(eq(tableBaseMembers.base_id, baseId), eq(tableBaseMembers.user_id, userId)))
        .limit(1);
      return rows[0];
    },

    async listBaseMembers(baseId: number): Promise<TableBaseMemberRow[]> {
      return db
        .select()
        .from(tableBaseMembers)
        .where(eq(tableBaseMembers.base_id, baseId))
        .orderBy(asc(tableBaseMembers.created_at));
    },

    async upsertBaseMember(input: {
      base_id: number;
      user_id: string;
      role: TableBaseRole;
      added_by: string;
    }): Promise<TableBaseMemberRow> {
      const now = nowIso();
      const [row] = await db
        .insert(tableBaseMembers)
        .values({ ...input, created_at: now, updated_at: now })
        .onConflictDoUpdate({
          target: [tableBaseMembers.base_id, tableBaseMembers.user_id],
          set: { role: input.role, added_by: input.added_by, updated_at: now },
        })
        .returning();
      return row!;
    },

    async removeBaseMember(baseId: number, userId: string): Promise<boolean> {
      const rows = await db
        .delete(tableBaseMembers)
        .where(and(eq(tableBaseMembers.base_id, baseId), eq(tableBaseMembers.user_id, userId)))
        .returning({ id: tableBaseMembers.id });
      return rows.length > 0;
    },
  };
}
