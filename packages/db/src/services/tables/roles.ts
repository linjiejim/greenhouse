/**
 * Base access grants beyond a person's own member row: custom roles (row / field
 * rules), group grants, the team default and owner transfer — plus the schema
 * facts the access compiler needs.
 *
 * Storage only. Deciding a person's level (`decideTableBaseAccess`) and
 * compiling rules into a scope (`compileTableAccessScope`) are pure functions in
 * `@greenhouse/types/table-access`, called by the API's
 * `platform/tables/access.ts`; rules are validated there before they get here.
 */

import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import type {
  TableAccessRules,
  TableAccessSchemaFacts,
  TableBaseGroupGrantFact,
  TableGroupMemberRole,
  TableRoleReferences,
  TableTeamRole,
} from '@greenhouse/types/table-access';
import type { TableBaseRole } from '@greenhouse/types/tables';
import type { Db } from '../../client.js';
import {
  groupMembers,
  tableBaseGroupMembers,
  tableBaseMembers,
  tableBaseRoles,
  tableBases,
  tableFieldDependencies,
  tableFields,
  tableTables,
  userGroups,
  users,
} from '../../schema/index.js';
import type { TableBaseGroupMemberRow, TableBaseRoleRow, TableBaseRow } from '../../schema/tables.js';
import { parseTableFieldConfig, trimmed, type TableRevisionResult } from './shared.js';

export interface CreateTableBaseRoleInput {
  base_id: number;
  name: string;
  description?: string | null;
  rules: TableAccessRules;
  created_by: string;
}

export interface UpdateTableBaseRoleInput {
  revision: number;
  name?: string;
  description?: string | null;
  rules?: TableAccessRules;
  position?: number;
  updated_by: string;
}

/** A group grant with what the share dialog shows next to it. */
export interface TableBaseGroupGrantRow extends TableBaseGroupMemberRow {
  group_name: string;
  /** The group's creator — the person who decides who is in it. */
  group_created_by: string;
  group_creator_name: string | null;
  member_count: number;
}

/** A group grant that reaches one person (`group_members` rows only). */
export interface TableUserGroupGrantRow extends TableBaseGroupGrantFact {
  user_id: string;
  group_id: number;
}

export type DeleteTableBaseRoleResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'in_use'; references: TableRoleReferences };

/** The new owner's previous standing is replaced; the old owner keeps `previousOwnerRole`. */
export type TablePreviousOwnerRole = Exclude<TableBaseRole, 'owner'> | 'remove';

function roleName(name: string): string {
  return trimmed(name, 'Role name', 60);
}

function roleDescription(description: string | null | undefined): string | null {
  const value = description?.trim();
  return value ? value.slice(0, 500) : null;
}

export function createTablesRoles(db: Db) {
  /** Grants that point at a role (same Base by construction — handlers check `role.base_id`). */
  const roleReferences = async (roleId: number): Promise<TableRoleReferences> => {
    const [members, groups, team] = await Promise.all([
      db.select({ n: count() }).from(tableBaseMembers).where(eq(tableBaseMembers.custom_role_id, roleId)),
      db.select({ n: count() }).from(tableBaseGroupMembers).where(eq(tableBaseGroupMembers.custom_role_id, roleId)),
      db.select({ n: count() }).from(tableBases).where(eq(tableBases.team_custom_role_id, roleId)),
    ]);
    return { users: Number(members[0]?.n ?? 0), groups: Number(groups[0]?.n ?? 0), team: Number(team[0]?.n ?? 0) > 0 };
  };

  const groupGrantsQuery = () =>
    db
      .select({
        user_id: groupMembers.user_id,
        group_id: tableBaseGroupMembers.group_id,
        role: tableBaseGroupMembers.role,
        custom_role_id: tableBaseGroupMembers.custom_role_id,
        custom_role_position: tableBaseRoles.position,
      })
      .from(tableBaseGroupMembers)
      .innerJoin(groupMembers, eq(groupMembers.group_id, tableBaseGroupMembers.group_id))
      .leftJoin(
        tableBaseRoles,
        and(
          eq(tableBaseRoles.id, tableBaseGroupMembers.custom_role_id),
          eq(tableBaseRoles.base_id, tableBaseGroupMembers.base_id),
        ),
      );

  return {
    roleReferences,

    async listBaseRoles(baseId: number): Promise<TableBaseRoleRow[]> {
      return db
        .select()
        .from(tableBaseRoles)
        .where(eq(tableBaseRoles.base_id, baseId))
        .orderBy(asc(tableBaseRoles.position), asc(tableBaseRoles.id));
    },

    async getBaseRole(roleId: number): Promise<TableBaseRoleRow | undefined> {
      const rows = await db.select().from(tableBaseRoles).where(eq(tableBaseRoles.id, roleId)).limit(1);
      return rows[0];
    },

    /** Reference counts for many roles of one Base (the roles tab). */
    async listRoleReferences(baseId: number): Promise<Map<number, TableRoleReferences>> {
      const [roles, members, groups, base] = await Promise.all([
        db.select({ id: tableBaseRoles.id }).from(tableBaseRoles).where(eq(tableBaseRoles.base_id, baseId)),
        db
          .select({ id: tableBaseMembers.custom_role_id, n: count() })
          .from(tableBaseMembers)
          .where(eq(tableBaseMembers.base_id, baseId))
          .groupBy(tableBaseMembers.custom_role_id),
        db
          .select({ id: tableBaseGroupMembers.custom_role_id, n: count() })
          .from(tableBaseGroupMembers)
          .where(eq(tableBaseGroupMembers.base_id, baseId))
          .groupBy(tableBaseGroupMembers.custom_role_id),
        db.select({ team: tableBases.team_custom_role_id }).from(tableBases).where(eq(tableBases.id, baseId)).limit(1),
      ]);
      const out = new Map<number, TableRoleReferences>();
      for (const role of roles) out.set(role.id, { users: 0, groups: 0, team: base[0]?.team === role.id });
      for (const row of members) if (row.id !== null && out.has(row.id)) out.get(row.id)!.users = Number(row.n);
      for (const row of groups) if (row.id !== null && out.has(row.id)) out.get(row.id)!.groups = Number(row.n);
      return out;
    },

    async createBaseRole(input: CreateTableBaseRoleInput): Promise<TableBaseRoleRow> {
      const now = nowIso();
      const [last] = await db
        .select({ position: sql<number>`coalesce(max(${tableBaseRoles.position}), -1)` })
        .from(tableBaseRoles)
        .where(eq(tableBaseRoles.base_id, input.base_id));
      const [row] = await db
        .insert(tableBaseRoles)
        .values({
          base_id: input.base_id,
          name: roleName(input.name),
          description: roleDescription(input.description),
          rules: input.rules,
          position: Number(last?.position ?? -1) + 1,
          revision: 1,
          created_by: input.created_by,
          updated_by: input.created_by,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    async updateBaseRole(
      roleId: number,
      patch: UpdateTableBaseRoleInput,
    ): Promise<TableRevisionResult<TableBaseRoleRow>> {
      const current = await db.select().from(tableBaseRoles).where(eq(tableBaseRoles.id, roleId)).limit(1);
      if (!current[0]) return { ok: false, reason: 'not_found' };
      if (current[0].revision !== patch.revision) {
        return { ok: false, reason: 'conflict', current: current[0].revision };
      }
      const values: Partial<typeof tableBaseRoles.$inferInsert> = {
        revision: current[0].revision + 1,
        updated_by: patch.updated_by,
        updated_at: nowIso(),
      };
      if (patch.name !== undefined) values.name = roleName(patch.name);
      if (patch.description !== undefined) values.description = roleDescription(patch.description);
      if (patch.rules !== undefined) values.rules = patch.rules;
      if (patch.position !== undefined) values.position = Math.max(0, Math.trunc(patch.position));
      const rows = await db
        .update(tableBaseRoles)
        .set(values)
        .where(and(eq(tableBaseRoles.id, roleId), eq(tableBaseRoles.revision, patch.revision)))
        .returning();
      if (!rows[0]) {
        const latest = await db
          .select({ revision: tableBaseRoles.revision })
          .from(tableBaseRoles)
          .where(eq(tableBaseRoles.id, roleId))
          .limit(1);
        return latest[0]
          ? { ok: false, reason: 'conflict', current: latest[0].revision }
          : { ok: false, reason: 'not_found' };
      }
      return { ok: true, value: rows[0] };
    },

    /**
     * Delete a role nobody uses (D13). The role row is locked first: a grant
     * that tries to reference it concurrently waits on the foreign-key check and
     * then fails, so the count cannot go stale between the check and the delete.
     */
    async deleteBaseRole(roleId: number): Promise<DeleteTableBaseRoleResult> {
      return db.transaction(async (tx) => {
        const [role] = await tx
          .select({ id: tableBaseRoles.id })
          .from(tableBaseRoles)
          .where(eq(tableBaseRoles.id, roleId))
          .limit(1)
          .for('update');
        if (!role) return { ok: false, reason: 'not_found' } as const;
        const [members, groups, team] = await Promise.all([
          tx.select({ n: count() }).from(tableBaseMembers).where(eq(tableBaseMembers.custom_role_id, roleId)),
          tx.select({ n: count() }).from(tableBaseGroupMembers).where(eq(tableBaseGroupMembers.custom_role_id, roleId)),
          tx.select({ n: count() }).from(tableBases).where(eq(tableBases.team_custom_role_id, roleId)),
        ]);
        const references: TableRoleReferences = {
          users: Number(members[0]?.n ?? 0),
          groups: Number(groups[0]?.n ?? 0),
          team: Number(team[0]?.n ?? 0) > 0,
        };
        if (references.users > 0 || references.groups > 0 || references.team) {
          return { ok: false, reason: 'in_use', references } as const;
        }
        await tx.delete(tableBaseRoles).where(eq(tableBaseRoles.id, roleId));
        return { ok: true } as const;
      });
    },

    // ─── Group grants ─────────────────────────────────────

    async listBaseGroupGrants(baseId: number): Promise<TableBaseGroupGrantRow[]> {
      const rows = await db
        .select({
          grant: tableBaseGroupMembers,
          group_name: userGroups.name,
          group_created_by: userGroups.created_by,
          group_creator_name: users.nickname,
          member_count: sql<number>`(SELECT count(*) FROM group_members gm WHERE gm.group_id = ${tableBaseGroupMembers.group_id})`,
        })
        .from(tableBaseGroupMembers)
        .innerJoin(userGroups, eq(userGroups.id, tableBaseGroupMembers.group_id))
        .leftJoin(users, eq(users.id, userGroups.created_by))
        .where(eq(tableBaseGroupMembers.base_id, baseId))
        .orderBy(asc(tableBaseGroupMembers.created_at), asc(tableBaseGroupMembers.id));
      return rows.map((row) => ({
        ...row.grant,
        group_name: row.group_name,
        group_created_by: row.group_created_by,
        group_creator_name: row.group_creator_name,
        member_count: Number(row.member_count),
      }));
    },

    async upsertBaseGroupGrant(input: {
      base_id: number;
      group_id: number;
      role: TableGroupMemberRole;
      custom_role_id: number | null;
      added_by: string;
    }): Promise<TableBaseGroupMemberRow> {
      const now = nowIso();
      const customRoleId = input.role === 'custom' ? input.custom_role_id : null;
      const [row] = await db
        .insert(tableBaseGroupMembers)
        .values({ ...input, custom_role_id: customRoleId, created_at: now, updated_at: now })
        .onConflictDoUpdate({
          target: [tableBaseGroupMembers.base_id, tableBaseGroupMembers.group_id],
          set: { role: input.role, custom_role_id: customRoleId, added_by: input.added_by, updated_at: now },
        })
        .returning();
      return row!;
    },

    async removeBaseGroupGrant(baseId: number, groupId: number): Promise<boolean> {
      const rows = await db
        .delete(tableBaseGroupMembers)
        .where(and(eq(tableBaseGroupMembers.base_id, baseId), eq(tableBaseGroupMembers.group_id, groupId)))
        .returning({ id: tableBaseGroupMembers.id });
      return rows.length > 0;
    },

    /** The group grants that reach one person on one Base — the resolver's group facts. */
    async listGroupGrantsForUser(baseId: number, userId: string): Promise<TableUserGroupGrantRow[]> {
      return groupGrantsQuery().where(and(eq(tableBaseGroupMembers.base_id, baseId), eq(groupMembers.user_id, userId)));
    },

    /** Every person reached by a group grant on one Base (fan-out over many users at once). */
    async listGroupGrantsForBase(baseId: number): Promise<TableUserGroupGrantRow[]> {
      return groupGrantsQuery().where(eq(tableBaseGroupMembers.base_id, baseId));
    },

    // ─── Team default and owner ───────────────────────────

    async setBaseTeamRole(
      baseId: number,
      teamRole: TableTeamRole,
      teamCustomRoleId: number | null,
    ): Promise<TableBaseRow | undefined> {
      const rows = await db
        .update(tableBases)
        .set({
          team_role: teamRole,
          team_custom_role_id: teamRole === 'custom' ? teamCustomRoleId : null,
          updated_at: nowIso(),
        })
        .where(eq(tableBases.id, baseId))
        .returning();
      return rows[0];
    },

    /**
     * Hand a Base to `newOwnerId` in one transaction: `owner_id`, the new
     * owner's member row (`owner`), and the previous owner's row
     * (`previousOwnerRole`, or deleted for `remove`). A member row saying
     * `owner` for anyone but `owner_id` would read as owner, so both rows are
     * always rewritten. Undefined when the Base is gone or archived.
     */
    async transferBaseOwner(
      baseId: number,
      input: { newOwnerId: string; previousOwnerRole: TablePreviousOwnerRole; actorId: string },
    ): Promise<TableBaseRow | undefined> {
      return db.transaction(async (tx) => {
        const [base] = await tx
          .select()
          .from(tableBases)
          .where(and(eq(tableBases.id, baseId), isNull(tableBases.archived_at)))
          .limit(1)
          .for('update');
        if (!base) return undefined;
        const previousOwnerId = base.owner_id;
        const now = nowIso();
        const [updated] = await tx
          .update(tableBases)
          .set({ owner_id: input.newOwnerId, updated_at: now })
          .where(eq(tableBases.id, baseId))
          .returning();
        await tx
          .insert(tableBaseMembers)
          .values({
            base_id: baseId,
            user_id: input.newOwnerId,
            role: 'owner',
            custom_role_id: null,
            added_by: input.actorId,
            created_at: now,
            updated_at: now,
          })
          .onConflictDoUpdate({
            target: [tableBaseMembers.base_id, tableBaseMembers.user_id],
            set: { role: 'owner', custom_role_id: null, added_by: input.actorId, updated_at: now },
          });
        if (previousOwnerId !== input.newOwnerId) {
          if (input.previousOwnerRole === 'remove') {
            await tx
              .delete(tableBaseMembers)
              .where(and(eq(tableBaseMembers.base_id, baseId), eq(tableBaseMembers.user_id, previousOwnerId)));
          } else {
            await tx
              .insert(tableBaseMembers)
              .values({
                base_id: baseId,
                user_id: previousOwnerId,
                role: input.previousOwnerRole,
                custom_role_id: null,
                added_by: input.actorId,
                created_at: now,
                updated_at: now,
              })
              .onConflictDoUpdate({
                target: [tableBaseMembers.base_id, tableBaseMembers.user_id],
                set: { role: input.previousOwnerRole, custom_role_id: null, added_by: input.actorId, updated_at: now },
              });
          }
        }
        return updated;
      });
    },

    // ─── Compiler facts ───────────────────────────────────

    /**
     * Live tables, their active fields and the computed fields' dependency edges
     * of one Base — everything `compileTableAccessScope` reads.
     */
    async loadAccessFacts(baseId: number): Promise<TableAccessSchemaFacts> {
      const tables = await db
        .select({ id: tableTables.id, name: tableTables.name })
        .from(tableTables)
        .where(and(eq(tableTables.base_id, baseId), isNull(tableTables.archived_at)))
        .orderBy(asc(tableTables.position), asc(tableTables.id));
      const tableIds = tables.map((table) => table.id);
      if (tableIds.length === 0) return { tables, fields: [], dependencies: [] };
      const fields = await db
        .select()
        .from(tableFields)
        .where(and(inArray(tableFields.table_id, tableIds), isNull(tableFields.archived_at)))
        .orderBy(asc(tableFields.position), asc(tableFields.id));
      const fieldIds = fields.map((field) => field.id);
      const dependencies =
        fieldIds.length === 0
          ? []
          : await db
              .select({
                fieldId: tableFieldDependencies.field_id,
                dependsOnFieldId: tableFieldDependencies.depends_on_field_id,
              })
              .from(tableFieldDependencies)
              .where(inArray(tableFieldDependencies.field_id, fieldIds));
      return {
        tables,
        fields: fields.map((field) => ({
          id: field.id,
          tableId: field.table_id,
          type: field.type,
          name: field.name,
          isPrimary: field.is_primary,
          relationTargetTableId:
            field.type === 'relation' ? (parseTableFieldConfig(field).relation?.targetTableId ?? null) : null,
        })),
        dependencies,
      };
    },
  };
}
