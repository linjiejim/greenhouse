/**
 * Slice A pure contracts: group grants in the decision table, rule
 * normalization (shape only, never dropping a row predicate), field access over
 * the dependency closure (D4 / D14) and the rules → scope compiler.
 */

import { describe, expect, it } from 'vitest';
import {
  compileTableAccessScope,
  computeFieldAccess,
  decideTableBaseAccess,
  fieldAccessFor,
  normalizeAccessRules,
  roleInUse,
  type TableAccessRule,
  type TableAccessRules,
  type TableAccessSchemaFacts,
  type TableBaseAccessFacts,
  type TableBaseGroupGrantFact,
} from '../table-access.js';

const team = { id: 'u-team', role: 'team', status: 'active' };
const base: TableBaseAccessFacts['base'] = {
  owner_id: 'u-owner',
  visibility: 'private',
  team_role: 'viewer',
  team_custom_role_id: null,
  archived_at: null,
};

function grant(role: TableBaseGroupGrantFact['role'], id: number | null = null, position: number | null = null) {
  return { role, custom_role_id: id, custom_role_position: position };
}

describe('decideTableBaseAccess — group grants (D2 / D12 / D13)', () => {
  const decide = (facts: Partial<TableBaseAccessFacts>) =>
    decideTableBaseAccess({ user: team, base, member: undefined, ...facts });

  it('ranks editor over custom over viewer, and picks the custom role with the smallest position', () => {
    expect(decide({ groups: [grant('viewer'), grant('editor')] })).toEqual({ level: 'editor', via: 'group' });
    expect(decide({ groups: [grant('viewer'), grant('custom', 5, 3), grant('custom', 9, 1)] })).toEqual({
      level: 'custom',
      via: 'group',
      customRoleId: 9,
    });
    expect(decide({ groups: [grant('viewer')] })).toEqual({ level: 'viewer', via: 'group' });
  });

  it('lets the own member row win over any group, even when it is lower', () => {
    expect(decide({ member: { role: 'viewer', custom_role_id: null }, groups: [grant('editor')] })).toEqual({
      level: 'viewer',
      via: 'member',
    });
  });

  it('never falls back to viewer when the only custom grants dangle', () => {
    expect(decide({ groups: [grant('viewer'), grant('custom', null)] }).level).toBe('none');
  });

  it('puts groups before the team default', () => {
    const teamEditors = { ...base, visibility: 'team' as const, team_role: 'editor' as const };
    expect(decide({ base: teamEditors, groups: [grant('viewer')] })).toEqual({ level: 'viewer', via: 'group' });
    expect(decide({ base: teamEditors, groups: [] })).toEqual({ level: 'editor', via: 'team' });
  });
});

describe('normalizeAccessRules', () => {
  const schema = { tables: [{ id: 1 }, { id: 2 }] };
  const rule = (overrides: Record<string, unknown> = {}) => ({
    tableId: 1,
    access: 'read',
    fields: [],
    fieldDefault: 'hidden',
    ...overrides,
  });

  it('keeps a valid document and drops rules for tables outside the Base', () => {
    const result = normalizeAccessRules(
      { version: 1, dashboards: 'all', tables: [rule(), rule({ tableId: 99 })] },
      schema,
    );
    expect(result).toEqual({
      ok: true,
      rules: {
        version: 1,
        dashboards: 'all',
        tables: [{ tableId: 1, access: 'read', fields: [], fieldDefault: 'hidden' }],
      },
    });
  });

  it('never drops a row predicate or a field entry, even when they point at nothing', () => {
    const where = { combinator: 'and', clauses: [{ fieldId: 404, operator: 'eq', value: 'x' }] };
    const result = normalizeAccessRules(
      {
        version: 1,
        dashboards: 'none',
        tables: [
          rule({
            rows: { type: 'where', where },
            editRows: { type: 'related', creator: false, fieldIds: [405] },
            fields: [{ fieldId: 406, access: 'hidden' }],
          }),
        ],
      },
      schema,
    );
    expect(result.ok && result.rules.tables[0]).toMatchObject({
      rows: { type: 'where', where },
      editRows: { type: 'related', creator: false, fieldIds: [405] },
      fields: [{ fieldId: 406, access: 'hidden' }],
    });
  });

  it.each([
    [{ version: 2, dashboards: 'all', tables: [] }, 'version'],
    [{ version: 1, dashboards: 'some', tables: [] }, 'dashboards'],
    [{ version: 1, dashboards: 'all', tables: [rule({ fieldDefault: undefined })] }, 'fieldDefault'],
    [{ version: 1, dashboards: 'all', tables: [rule({ access: 'write' })] }, 'access'],
    [{ version: 1, dashboards: 'all', tables: [rule(), rule()] }, 'twice'],
    [
      {
        version: 1,
        dashboards: 'all',
        tables: [rule({ rows: { type: 'where', where: { combinator: 'and', clauses: [] } } })],
      },
      'clauses',
    ],
    [
      { version: 1, dashboards: 'all', tables: [rule({ rows: { type: 'related', creator: false, fieldIds: [] } })] },
      'creator',
    ],
    [{ version: 1, dashboards: 'all', tables: [rule({ rows: { type: 'some' } })] }, 'type'],
    [{ version: 1, dashboards: 'all', tables: [rule({ fields: [{ fieldId: 3, access: 'write' }] })] }, 'access'],
  ])('refuses a malformed document (%#)', (raw, message) => {
    const result = normalizeAccessRules(raw, schema);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(message);
  });

  it('keeps every rule when re-checking stored rules without a schema', () => {
    const result = normalizeAccessRules({ version: 1, dashboards: 'all', tables: [rule({ tableId: 99 })] });
    expect(result.ok && result.rules.tables.map((entry) => entry.tableId)).toEqual([99]);
  });
});

// 客户 (customers, table 1) and 订单 (orders, table 2), the acceptance example.
const facts: TableAccessSchemaFacts = {
  tables: [{ id: 1 }, { id: 2 }],
  fields: [
    { id: 10, tableId: 1, type: 'text' }, // 名称
    { id: 11, tableId: 1, type: 'number' }, // 合同金额
    { id: 12, tableId: 1, type: 'user' }, // 负责人
    { id: 13, tableId: 1, type: 'formula' }, // 金额 × 0.1 (depends on 11)
    { id: 14, tableId: 1, type: 'formula' }, // 名称 upper (depends on 10)
    { id: 20, tableId: 2, type: 'text' }, // 订单号
    { id: 21, tableId: 2, type: 'relation', relationTargetTableId: 1 }, // 客户
    { id: 22, tableId: 2, type: 'rollup' }, // 客户.合同金额
    { id: 23, tableId: 2, type: 'lookup' }, // 客户.名称
    { id: 24, tableId: 2, type: 'attachment' },
  ],
  dependencies: [
    { fieldId: 13, dependsOnFieldId: 11 },
    { fieldId: 14, dependsOnFieldId: 10 },
    { fieldId: 22, dependsOnFieldId: 21 },
    { fieldId: 22, dependsOnFieldId: 11 },
    { fieldId: 23, dependsOnFieldId: 21 },
    { fieldId: 23, dependsOnFieldId: 10 },
  ],
};

const customers: TableAccessRule = {
  tableId: 1,
  access: 'read',
  rows: { type: 'related', creator: false, fieldIds: [12] },
  fields: [{ fieldId: 11, access: 'hidden' }],
  fieldDefault: 'visible',
};
const orders: TableAccessRule = {
  tableId: 2,
  access: 'edit',
  rows: { type: 'related', creator: true, fieldIds: [] },
  fields: [],
  fieldDefault: 'visible',
};
const sales: TableAccessRules = { version: 1, dashboards: 'all', tables: [customers, orders] };

describe('field access', () => {
  it('declares from the entry, else fieldDefault, capped by the table rule', () => {
    expect(fieldAccessFor(customers, 11)).toBe('hidden');
    expect(fieldAccessFor(customers, 10)).toBe('read'); // visible on a read rule
    expect(fieldAccessFor(orders, 20)).toBe('edit');
    expect(fieldAccessFor({ ...orders, fieldDefault: 'hidden' }, 20)).toBe('hidden');
    expect(fieldAccessFor({ ...customers, fields: [{ fieldId: 10, access: 'edit' }] }, 10)).toBe('read');
    expect(fieldAccessFor(undefined, 10)).toBe('hidden');
  });

  it('hides computed fields whose closure reaches a hidden field — same table and across a relation (D4)', () => {
    const access = computeFieldAccess(sales, facts);
    expect(access.get(13)).toEqual({ access: 'hidden', reason: 'dependency_hidden' });
    expect(access.get(14)).toEqual({ access: 'read' });
    expect(access.get(22)).toEqual({ access: 'hidden', reason: 'dependency_hidden' });
    expect(access.get(23)).toEqual({ access: 'read' });
  });

  it('hides rollups and lookups whose target table has no rule, and keeps their relation read-only (D14)', () => {
    const access = computeFieldAccess({ ...sales, tables: [orders] }, facts);
    expect(access.get(21)).toEqual({ access: 'read', reason: 'relation_target_hidden' });
    expect(access.get(22)?.access).toBe('hidden');
    expect(access.get(23)?.access).toBe('hidden');
    expect(access.get(10)?.access).toBe('hidden');
  });

  it('fails closed on unknown and cyclic dependencies', () => {
    const cyclic: TableAccessSchemaFacts = {
      tables: [{ id: 1 }],
      fields: [
        { id: 1, tableId: 1, type: 'formula' },
        { id: 2, tableId: 1, type: 'formula' },
        { id: 3, tableId: 1, type: 'formula' },
      ],
      dependencies: [
        { fieldId: 1, dependsOnFieldId: 2 },
        { fieldId: 2, dependsOnFieldId: 1 },
        { fieldId: 3, dependsOnFieldId: 999 },
      ],
    };
    const access = computeFieldAccess(
      { version: 1, dashboards: 'none', tables: [{ tableId: 1, access: 'read', fields: [], fieldDefault: 'visible' }] },
      cyclic,
    );
    expect(access.get(1)?.access).toBe('hidden');
    expect(access.get(3)?.access).toBe('hidden');
  });
});

describe('compileTableAccessScope', () => {
  it('compiles a rule into rows, readable / editable fields, switches and relation targets', () => {
    expect(compileTableAccessScope(sales, 1, facts, 'u-1')).toEqual({
      kind: 'scoped',
      userId: 'u-1',
      tableId: 1,
      rows: [customers.rows],
      editRows: [],
      readableFieldIds: [10, 12, 14],
      editableFieldIds: [],
      canCreate: false,
      canDelete: false,
      relationTargets: [],
    });
    expect(compileTableAccessScope(sales, 2, facts, 'u-1')).toEqual({
      kind: 'scoped',
      userId: 'u-1',
      tableId: 2,
      rows: [orders.rows],
      editRows: [],
      readableFieldIds: [20, 21, 23, 24],
      editableFieldIds: [20, 21, 24],
      canCreate: true,
      canDelete: false,
      relationTargets: [{ tableId: 1, rows: [customers.rows] }],
    });
  });

  it('is undefined for a table without a rule, drops `all` scopes and honours create / delete / editRows', () => {
    expect(compileTableAccessScope({ ...sales, tables: [orders] }, 1, facts, 'u-1')).toBeUndefined();
    const scope = compileTableAccessScope(
      {
        ...sales,
        tables: [
          {
            ...orders,
            rows: { type: 'all' },
            editRows: { type: 'related', creator: true, fieldIds: [] },
            create: false,
            delete: true,
          },
        ],
      },
      2,
      facts,
      'u-1',
    );
    expect(scope).toMatchObject({
      rows: [],
      editRows: [{ type: 'related', creator: true, fieldIds: [] }],
      canCreate: false,
      canDelete: true,
      relationTargets: [],
      editableFieldIds: [20, 24],
    });
  });

  it('keeps a malformed row scope so the SQL compiler can fail it closed', () => {
    const broken = { type: 'bogus' } as unknown as TableAccessRule['rows'];
    const scope = compileTableAccessScope({ ...sales, tables: [{ ...customers, rows: broken }] }, 1, facts, 'u-1');
    expect(scope?.rows).toEqual([broken]);
  });
});

describe('roleInUse', () => {
  it('counts people, groups and the team default', () => {
    expect(roleInUse({ users: 0, groups: 0, team: false })).toBe(false);
    expect(roleInUse({ users: 1, groups: 0, team: false })).toBe(true);
    expect(roleInUse({ users: 0, groups: 0, team: true })).toBe(true);
  });
});
