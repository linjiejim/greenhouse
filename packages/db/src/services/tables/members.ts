/**
 * Base membership rows. Effective-role resolution (owner / member / group /
 * team default, custom roles) lives in the API's `platform/tables/access.ts`;
 * the db layer only stores and reads the grants.
 */

import { and, asc, eq } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import type { TableBaseRole } from '@greenhouse/types/tables';
import type { Db } from '../../client.js';
import { tableBaseMembers } from '../../schema/index.js';
import type { TableBaseMemberRow } from '../../schema/tables.js';

export function createTablesMembers(db: Db) {
  return {
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
