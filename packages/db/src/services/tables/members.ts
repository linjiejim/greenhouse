/**
 * Base membership rows (people). Effective-role resolution (owner / member /
 * group / team default, custom roles) lives in the API's
 * `platform/tables/access.ts`; the db layer only stores and reads the grants.
 * Group grants, roles, the team default and owner transfer are in `./roles.ts`.
 */

import { and, asc, eq } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import { resolveCapability } from '@greenhouse/platform-kernel';
import { decideTableBaseAccess, tableRoleAtLeast, type TableBaseMemberRole } from '@greenhouse/types/table-access';
import type { Db } from '../../client.js';
import {
  groupMembers,
  tableBaseGroupMembers,
  tableBaseMembers,
  tableBaseRoles,
  tableBases,
  users,
} from '../../schema/index.js';
import type { TableBaseMemberRow } from '../../schema/tables.js';
import { createPlatformService } from '../platform.js';

export function createTablesMembers(db: Db) {
  const platform = createPlatformService(db);

  /**
   * Can this user edit records of the Base? The legacy automation executor's
   * check, which runs inside the record write path where the API cannot supply
   * a resolution. It decides with the same table as the API's
   * `platform/tables/access.ts` (`decideTableBaseAccess`, group grants
   * included); only the facts are loaded here. A custom role never qualifies.
   * Slice Au moves execution into the API worker, which calls
   * `resolveBaseAccess` directly, and deletes this.
   */
  const canUserEditBase = async (baseId: number, userId: string): Promise<boolean> => {
    const [user, base, member, groups, authorization] = await Promise.all([
      db.select().from(users).where(eq(users.id, userId)).limit(1),
      db.select().from(tableBases).where(eq(tableBases.id, baseId)).limit(1),
      db
        .select()
        .from(tableBaseMembers)
        .where(and(eq(tableBaseMembers.base_id, baseId), eq(tableBaseMembers.user_id, userId)))
        .limit(1),
      db
        .select({
          role: tableBaseGroupMembers.role,
          custom_role_id: tableBaseGroupMembers.custom_role_id,
          custom_role_position: tableBaseRoles.position,
        })
        .from(tableBaseGroupMembers)
        .innerJoin(groupMembers, eq(groupMembers.group_id, tableBaseGroupMembers.group_id))
        .leftJoin(tableBaseRoles, eq(tableBaseRoles.id, tableBaseGroupMembers.custom_role_id))
        .where(and(eq(tableBaseGroupMembers.base_id, baseId), eq(groupMembers.user_id, userId))),
      platform.getAuthorizationSnapshot(userId, 'default'),
    ]);
    if (!base[0]) return false;
    const { level } = decideTableBaseAccess({ user: user[0], base: base[0], member: member[0], groups });
    if (level === 'none' || level === 'custom' || !tableRoleAtLeast(level, 'editor')) return false;
    return resolveCapability({ capability: 'tables.data.update', ...authorization }).allowed;
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

    /**
     * Add or change a person's grant. `custom_role_id` is kept only for
     * `custom` (the caller checks the role belongs to this Base); a `custom`
     * row without one resolves to no access, never to viewer (D13).
     */
    async upsertBaseMember(input: {
      base_id: number;
      user_id: string;
      role: TableBaseMemberRole;
      custom_role_id?: number | null;
      added_by: string;
    }): Promise<TableBaseMemberRow> {
      const now = nowIso();
      const customRoleId = input.role === 'custom' ? (input.custom_role_id ?? null) : null;
      const [row] = await db
        .insert(tableBaseMembers)
        .values({ ...input, custom_role_id: customRoleId, created_at: now, updated_at: now })
        .onConflictDoUpdate({
          target: [tableBaseMembers.base_id, tableBaseMembers.user_id],
          set: { role: input.role, custom_role_id: customRoleId, added_by: input.added_by, updated_at: now },
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
