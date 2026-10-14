/**
 * Custom roles of a base (TBL-14, base_roles). Owners make them and give them in the share
 * dialog: per data table, seen or not, read or edited, which records (a filter, `$me` is the
 * reader) and which fields stay hidden. access.ts adds a member's roles up; scope.ts applies
 * them on every read and write. A role changes what people see at once: everyone who sees the
 * base refetches it.
 */

import { and, asc, eq, max, sql } from 'drizzle-orm';
import {
  MAX_ROLES,
  isSystemField,
  operatorsFor,
  roleRulesSchema,
  valueTypeOf,
  type BaseCustomRole,
  type CreateRoleInput,
  type RoleRules,
  type RoleTableRules,
  type UpdateRoleInput,
} from '@greenhouse/contract';
import {
  baseFields,
  baseRoles,
  baseTables,
  getDb,
  newId,
  shares,
  transaction,
  type BaseRoleRow,
  type BaseRow,
} from '@greenhouse/db';
import { isUniqueViolation } from '@greenhouse/utils/error';
import { audit } from '../../audit.js';
import { ApiError, conflict, invalidInput, notFound } from '../../http/errors.js';
import { asNotFound, baseAt, loadReader, type TablesReader } from './access.js';

const nameTaken = () => conflict('name_taken', 'This base already has a role with that name.');

export const toRole = (row: BaseRoleRow): BaseCustomRole => {
  const rules = roleRulesSchema.safeParse(row.rules);
  return {
    id: row.id,
    base_id: row.baseId,
    name: row.name,
    description: row.description,
    rules: rules.success ? rules.data : { tables: {} },
    position: row.position,
    revision: row.revision,
  };
};

/** Rules checked against the base: its data tables and their fields; a role names no table to see nothing of it. */
export async function cleanRules(baseId: string, rules: RoleRules): Promise<RoleRules> {
  const tables = await getDb().select({ id: baseTables.id }).from(baseTables).where(eq(baseTables.baseId, baseId));
  const known = new Set(tables.map((table) => table.id));
  const entries = Object.entries(rules.tables);
  if (entries.some(([id]) => !known.has(id))) throw invalidInput('Some data tables are not in this base.');
  const out: Record<string, RoleTableRules> = {};
  for (const [tableId, entry] of entries) {
    if (entry.access === 'none') continue;
    const fields = await getDb().select().from(baseFields).where(eq(baseFields.tableId, tableId));
    const byId = new Map(fields.map((field) => [field.id, field]));
    const hidden = [...new Set(entry.hidden_fields ?? [])];
    for (const id of hidden) {
      const field = byId.get(id);
      if (!field) throw invalidInput('Some hidden fields are not in this data table.', { table: tableId });
      if (field.isPrimary) throw invalidInput('The primary field cannot be hidden: it names the record.');
    }
    const rows = entry.rows && entry.rows.clauses.length ? entry.rows : null;
    for (const clause of rows?.clauses ?? []) {
      if (isSystemField(clause.field)) {
        if (!operatorsFor(clause.field).includes(clause.op)) throw invalidInput('Some record rules cannot be read.');
        continue;
      }
      const field = byId.get(clause.field);
      if (!field || field.archivedAt) throw invalidInput('Some record rules name a field that is not there.');
      if (
        !operatorsFor(valueTypeOf({ type: field.type, config: { result: field.config.result } })).includes(clause.op)
      ) {
        throw invalidInput(`「${field.name}」 cannot be used that way in a record rule.`);
      }
    }
    out[tableId] = {
      access: entry.access,
      ...(rows ? { rows } : {}),
      ...(hidden.length ? { hidden_fields: hidden } : {}),
    };
  }
  return { tables: out };
}

export function createRoles(deps: {
  /** Who sees the base changed: forget the cached audience and have everyone refetch the base. */
  changed(base: BaseRow): Promise<void>;
}) {
  async function ownedRole(reader: TablesReader, roleId: string) {
    const [row] = await getDb().select().from(baseRoles).where(eq(baseRoles.id, roleId));
    if (!row) throw notFound('Role');
    const { base } = await asNotFound('Role', () => baseAt(reader, row.baseId, 'owner'));
    return { row, base };
  }

  return {
    /** The roles of a base (its owners). */
    async list(memberId: string, baseId: string): Promise<{ items: BaseCustomRole[] }> {
      const reader = await loadReader(memberId);
      await baseAt(reader, baseId, 'owner');
      const rows = await getDb()
        .select()
        .from(baseRoles)
        .where(eq(baseRoles.baseId, baseId))
        .orderBy(asc(baseRoles.position), asc(baseRoles.name), asc(baseRoles.id));
      return { items: rows.map(toRole) };
    },

    async create(memberId: string, baseId: string, input: CreateRoleInput): Promise<BaseCustomRole> {
      const reader = await loadReader(memberId);
      const { base } = await baseAt(reader, baseId, 'owner');
      const rules = await cleanRules(baseId, input.rules ?? { tables: {} });
      try {
        const row = await transaction(async () => {
          const [{ n, top } = { n: 0, top: null }] = await getDb()
            .select({ n: sql<number>`count(*)::int`, top: max(baseRoles.position) })
            .from(baseRoles)
            .where(eq(baseRoles.baseId, baseId));
          if (n >= MAX_ROLES) throw conflict('too_many_roles', `A base has up to ${MAX_ROLES} roles.`);
          const [made] = await getDb()
            .insert(baseRoles)
            .values({
              id: newId('baseRole'),
              baseId,
              name: input.name,
              description: input.description ?? '',
              rules,
              position: (top ?? -1) + 1,
              createdBy: memberId,
            })
            .returning();
          await audit({
            actorId: memberId,
            action: 'base_role.create',
            resourceType: 'base_role',
            resourceId: made!.id,
            scopeType: 'base',
            scopeId: baseId,
            summary: `${Object.keys(rules.tables).length} tables`,
          });
          return made!;
        });
        await deps.changed(base);
        return toRole(row);
      } catch (error) {
        if (!(error instanceof ApiError) && isUniqueViolation(error)) throw nameTaken();
        throw error;
      }
    },

    /** A change based on `revision`; a newer role answers 409 `stale_revision` with the role now. */
    async update(memberId: string, roleId: string, input: UpdateRoleInput): Promise<BaseCustomRole> {
      const reader = await loadReader(memberId);
      const { row, base } = await ownedRole(reader, roleId);
      const rules = input.rules ? await cleanRules(base.id, input.rules) : undefined;
      try {
        const saved = await transaction(async () => {
          const [updated] = await getDb()
            .update(baseRoles)
            .set({
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.description !== undefined ? { description: input.description } : {}),
              ...(input.position !== undefined ? { position: input.position } : {}),
              ...(rules ? { rules } : {}),
              revision: sql`${baseRoles.revision} + 1`,
              updatedAt: sql`now()`,
            })
            .where(and(eq(baseRoles.id, roleId), eq(baseRoles.revision, input.revision)))
            .returning();
          if (!updated) return null;
          await audit({
            actorId: memberId,
            action: 'base_role.update',
            resourceType: 'base_role',
            resourceId: roleId,
            scopeType: 'base',
            scopeId: base.id,
            summary: Object.keys(input)
              .filter((key) => key !== 'revision')
              .join(', '),
          });
          return updated;
        });
        if (!saved) {
          const [now] = await getDb().select().from(baseRoles).where(eq(baseRoles.id, row.id));
          throw new ApiError(409, 'stale_revision', 'Someone changed this role. Reload it first.', {
            role: now ? toRole(now) : null,
          });
        }
        await deps.changed(base);
        return toRole(saved);
      } catch (error) {
        if (!(error instanceof ApiError) && isUniqueViolation(error)) throw nameTaken();
        throw error;
      }
    },

    /** Deletes a role: whoever had it through a share has it no more. */
    async remove(memberId: string, roleId: string): Promise<void> {
      const reader = await loadReader(memberId);
      const { row, base } = await ownedRole(reader, roleId);
      await transaction(async () => {
        await getDb()
          .delete(shares)
          .where(and(eq(shares.resourceType, 'base'), eq(shares.resourceId, base.id), eq(shares.customRoleId, row.id)));
        await getDb().delete(baseRoles).where(eq(baseRoles.id, row.id));
        await audit({
          actorId: memberId,
          action: 'base_role.delete',
          resourceType: 'base_role',
          resourceId: row.id,
          scopeType: 'base',
          scopeId: base.id,
          summary: row.name,
        });
      });
      await deps.changed(base);
    },
  };
}

export type RolesPart = ReturnType<typeof createRoles>;
