/**
 * The Base an app is built on, as the builder needs it: its tables and their
 * fields (pickers, conditions, defaults), its button automations (what
 * `run_automation` may name), the people directory (conditions, prefills),
 * who may own an app here (a hand-over target) and the access facts the role
 * editor computes effective field access from.
 *
 * Builders are Base owners / builders, so the Tables API answers them in
 * full. The facts with computed-field dependency edges come from the server
 * only (`listTableBaseRoles`, owner / super — the role editor never derives
 * dependencies in the browser); a builder who is not the owner gets the
 * tables and fields without edges, and the editor says computed fields are
 * settled by the server.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  decideTableBaseAccess,
  tableRoleAtLeast,
  type TableAccessSchemaFacts,
  type TableBaseAccessFacts,
} from '@greenhouse/types/table-access';
import {
  getTableBase,
  getTableSchema,
  listTableAutomations,
  listTableBaseAccess,
  listTableBaseRoles,
  listTableUsers,
  type TableBaseMemberGrant,
  type TableField,
  type TableUser,
  type TableUserOption,
} from '../../../lib/api/tables';
import { fieldConfig } from '../../../components/tables/field-types';
import type { BuilderSchema } from './spec-model';

export interface BuilderBase {
  schema: BuilderSchema;
  users: TableUserOption[];
  /** People who may own an app on this Base (`appOwnerCandidates`): whom it can be handed to. */
  appOwners: TableUserOption[];
  facts: TableAccessSchemaFacts;
  /** The facts carry the server's dependency edges (owner / super); otherwise computed fields show as declared. */
  exactFacts: boolean;
}

export type BuilderBaseLoad = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; base: BuilderBase };

/** Tables and fields as the access compiler sees them, without dependency edges. */
export function factsWithoutDependencies(schema: BuilderSchema): TableAccessSchemaFacts {
  return {
    tables: schema.tables.map((table) => ({ id: table.id, name: table.name })),
    fields: schema.tables.flatMap((table) =>
      (schema.fieldsByTable.get(table.id) ?? []).map((field) => ({
        id: field.id,
        tableId: table.id,
        type: field.type,
        relationTargetTableId: fieldConfig(field).relation?.targetTableId ?? null,
        name: field.name,
        isPrimary: field.is_primary,
      })),
    ),
    dependencies: [],
  };
}

/**
 * Who may own an app on this Base — the server's rule for a hand-over: an
 * owner or builder of the Base (its owner, a builder member, a super), decided
 * by the one decision table. Group and team grants never reach builder, so the
 * people's own member rows are all it needs.
 */
export function appOwnerCandidates(
  users: readonly TableUser[],
  base: TableBaseAccessFacts['base'],
  members: readonly Pick<TableBaseMemberGrant, 'user_id' | 'role' | 'custom_role_id'>[],
): TableUserOption[] {
  const memberOf = new Map(members.map((member) => [member.user_id, member]));
  return users
    .filter((user) => {
      const { level } = decideTableBaseAccess({
        user: { id: user.id, role: user.role, status: 'active' },
        base,
        member: memberOf.get(user.id) ?? null,
      });
      return level !== 'none' && level !== 'custom' && tableRoleAtLeast(level, 'builder');
    })
    .map(({ id, nickname, email }) => ({ id, nickname, email }));
}

export function useBuilderBase(baseId: number | undefined, canPublish: boolean) {
  const [load, setLoad] = useState<BuilderBaseLoad>({ kind: 'loading' });

  const read = useCallback(async () => {
    if (!baseId) return;
    setLoad({ kind: 'loading' });
    try {
      const [workspace, automations, users, access] = await Promise.all([
        getTableBase(baseId),
        listTableAutomations(baseId).catch(() => []),
        listTableUsers().catch((): TableUser[] => []),
        // Member rows (who builds here); unreadable → only the owner and supers are offered.
        listTableBaseAccess(baseId).catch(() => null),
      ]);
      const schemas = await Promise.all(workspace.tables.map((table) => getTableSchema(table.id)));
      const fieldsByTable = new Map<number, TableField[]>(
        schemas.map((entry) => [entry.table.id, entry.fields.filter((field) => field.archived_at === null)]),
      );
      const schema: BuilderSchema = {
        baseId,
        tables: workspace.tables,
        fieldsByTable,
        buttonRules: automations
          .filter((rule) => rule.trigger === 'button')
          .map((rule) => ({
            id: rule.id,
            tableId: rule.table_id,
            name: rule.name,
            enabled: rule.status === 'enabled',
          })),
      };
      const serverFacts = canPublish
        ? await listTableBaseRoles(baseId).then(
            (list) => list.facts,
            () => null,
          )
        : null;
      setLoad({
        kind: 'ready',
        base: {
          schema,
          users,
          appOwners: appOwnerCandidates(users, workspace.base, access?.members ?? []),
          facts: serverFacts ?? factsWithoutDependencies(schema),
          exactFacts: serverFacts !== null,
        },
      });
    } catch {
      setLoad({ kind: 'failed' });
    }
  }, [baseId, canPublish]);

  useEffect(() => {
    void read();
  }, [read]);

  return { load, reload: read };
}
