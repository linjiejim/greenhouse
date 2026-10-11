/**
 * Tables access storage (Phase 0 slice A) against real PostgreSQL, rolled back
 * per test: custom roles (revisions, reference counts, 409 while referenced),
 * group grants (only `group_members` rows count), the team default, owner
 * transfer, the compiler's schema facts, and the two scoped write rules —
 * relation targets inside the writer's read rows (D14) and attachments limited
 * to the writer's own fresh uploads (D15).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type TableFieldRow, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import {
  compileTableAccessScope,
  fullTableAccess,
  type TableAccessRules,
  type TableDataScope,
} from '@greenhouse/types/table-access';
import type { TableRecordWriteMeta } from '@greenhouse/types/tables';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let sales: UserRow;
let other: UserRow;
let groupOwner: UserRow;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  [owner, sales, other, groupOwner] = await Promise.all([
    createInternalTestUser(db, { email: `tables-a-owner-${tag}@test.local`, nickname: 'Access Owner' }),
    createInternalTestUser(db, { email: `tables-a-sales-${tag}@test.local`, nickname: 'Access Sales' }),
    createInternalTestUser(db, { email: `tables-a-other-${tag}@test.local`, nickname: 'Access Other' }),
    createInternalTestUser(db, { email: `tables-a-gowner-${tag}@test.local`, nickname: 'Group Owner' }),
  ]);
});

afterEach(() => {
  _resetProvider();
});

const meta = (actorId: string): TableRecordWriteMeta => ({ actorId, actorKind: 'user', enqueueAutomations: false });
const RULES: TableAccessRules = { version: 1, dashboards: 'none', tables: [] };

/** 客户 (customers) and 订单 (orders): the acceptance example. */
async function crm() {
  const base = await db.tables.createBase({ name: 'CRM', owner_id: owner.id, created_by: owner.id });
  const customers = await db.tables.createTable({ base_id: base.id, name: 'Customers', created_by: owner.id });
  const orders = await db.tables.createTable({ base_id: base.id, name: 'Orders', created_by: owner.id });
  const field = (tableId: number, name: string, type: TableFieldRow['type'], config?: object) =>
    db.tables.createField({ table_id: tableId, name, type, created_by: owner.id, config });
  const customerName = customers.fields[0]!;
  const amount = await field(customers.table.id, 'Amount', 'number');
  const rep = await field(customers.table.id, 'Rep', 'user');
  const commission = await field(customers.table.id, 'Commission', 'formula', {
    formula: {
      resultType: 'number',
      expression: {
        type: 'binary',
        operator: 'multiply',
        left: { type: 'field', fieldId: amount.id },
        right: { type: 'literal', value: 0.1 },
      },
    },
  });
  const orderNo = orders.fields[0]!;
  const customer = await field(orders.table.id, 'Customer', 'relation', {
    relation: { targetTableId: customers.table.id },
  });
  const total = await field(orders.table.id, 'Customer amount', 'rollup', {
    rollup: { relationFieldId: customer.id, targetFieldId: amount.id, aggregation: 'sum' },
  });
  const files = await field(orders.table.id, 'Files', 'attachment');
  const full = fullTableAccess(owner.id);
  const mine = await db.tables.createRecord(
    { table_id: customers.table.id, values: { [customerName.id]: 'Mine', [amount.id]: 100, [rep.id]: sales.id } },
    full,
    meta(owner.id),
  );
  const theirs = await db.tables.createRecord(
    {
      table_id: customers.table.id,
      values: { [customerName.id]: 'Theirs', [amount.id]: 9_000_000, [rep.id]: other.id },
    },
    full,
    meta(owner.id),
  );
  const rules: TableAccessRules = {
    version: 1,
    dashboards: 'all',
    tables: [
      {
        tableId: customers.table.id,
        access: 'read',
        rows: { type: 'related', creator: false, fieldIds: [rep.id] },
        fields: [{ fieldId: amount.id, access: 'hidden' }],
        fieldDefault: 'visible',
      },
      {
        tableId: orders.table.id,
        access: 'edit',
        rows: { type: 'related', creator: true, fieldIds: [] },
        fields: [],
        fieldDefault: 'visible',
      },
    ],
  };
  return {
    base,
    customers: customers.table.id,
    orders: orders.table.id,
    fields: { customerName, amount, rep, commission, orderNo, customer, total, files },
    mine,
    theirs,
    rules,
  };
}

async function upload(baseId: number, uploader: UserRow, name = 'contract.pdf') {
  const file = await db.drive.initFile({
    scope: 'tables',
    name,
    cos_key: `tables/${baseId}/${name}-${Math.random()}`,
    size: 10,
    base_id: baseId,
    uploaded_by: uploader.id,
  });
  return (await db.drive.completeFile(file.id, { size: 10 }))!;
}

async function salesScope(w: Awaited<ReturnType<typeof crm>>, tableId: number): Promise<TableDataScope> {
  return compileTableAccessScope(w.rules, tableId, await db.tables.loadAccessFacts(w.base.id), sales.id)!;
}

describe('custom roles', () => {
  it('creates, revises and lists roles with their reference counts', async () => {
    const w = await crm();
    const first = await db.tables.createBaseRole({
      base_id: w.base.id,
      name: ' Sales ',
      rules: w.rules,
      created_by: owner.id,
    });
    const second = await db.tables.createBaseRole({
      base_id: w.base.id,
      name: 'Audit',
      rules: RULES,
      created_by: owner.id,
    });
    expect(first).toMatchObject({ name: 'Sales', position: 0, revision: 1 });
    expect(second.position).toBe(1);

    expect(await db.tables.updateBaseRole(first.id, { revision: 7, name: 'x', updated_by: owner.id })).toEqual({
      ok: false,
      reason: 'conflict',
      current: 1,
    });
    const renamed = await db.tables.updateBaseRole(first.id, {
      revision: 1,
      name: 'Field sales',
      description: '  Own customers only ',
      updated_by: owner.id,
    });
    expect(renamed).toMatchObject({
      ok: true,
      value: { name: 'Field sales', description: 'Own customers only', revision: 2 },
    });

    await db.tables.upsertBaseMember({
      base_id: w.base.id,
      user_id: sales.id,
      role: 'custom',
      custom_role_id: first.id,
      added_by: owner.id,
    });
    const references = await db.tables.listRoleReferences(w.base.id);
    expect(references.get(first.id)).toEqual({ users: 1, groups: 0, team: false });
    expect(references.get(second.id)).toEqual({ users: 0, groups: 0, team: false });
    expect((await db.tables.listBaseRoles(w.base.id)).map((role) => role.id)).toEqual([first.id, second.id]);
  });

  it('refuses to delete a role a person, a group or the team default still uses (D13)', async () => {
    const w = await crm();
    const role = await db.tables.createBaseRole({
      base_id: w.base.id,
      name: 'Sales',
      rules: w.rules,
      created_by: owner.id,
    });
    const group = await db.groups.create({ name: 'Reps', created_by: owner.id });

    await db.tables.upsertBaseMember({
      base_id: w.base.id,
      user_id: sales.id,
      role: 'custom',
      custom_role_id: role.id,
      added_by: owner.id,
    });
    await db.tables.upsertBaseGroupGrant({
      base_id: w.base.id,
      group_id: group.id,
      role: 'custom',
      custom_role_id: role.id,
      added_by: owner.id,
    });
    await db.tables.setBaseTeamRole(w.base.id, 'custom', role.id);
    expect(await db.tables.deleteBaseRole(role.id)).toEqual({
      ok: false,
      reason: 'in_use',
      references: { users: 1, groups: 1, team: true },
    });

    await db.tables.upsertBaseMember({
      base_id: w.base.id,
      user_id: sales.id,
      role: 'viewer',
      custom_role_id: role.id,
      added_by: owner.id,
    });
    await db.tables.removeBaseGroupGrant(w.base.id, group.id);
    expect(await db.tables.deleteBaseRole(role.id)).toMatchObject({ reason: 'in_use', references: { team: true } });
    await db.tables.setBaseTeamRole(w.base.id, 'viewer', role.id);
    expect((await db.tables.getBase(w.base.id))?.team_custom_role_id).toBeNull();
    expect(await db.tables.deleteBaseRole(role.id)).toEqual({ ok: true });
    expect(await db.tables.deleteBaseRole(role.id)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('keeps a custom role id only on custom grants', async () => {
    const w = await crm();
    const role = await db.tables.createBaseRole({
      base_id: w.base.id,
      name: 'Sales',
      rules: w.rules,
      created_by: owner.id,
    });
    const member = await db.tables.upsertBaseMember({
      base_id: w.base.id,
      user_id: sales.id,
      role: 'editor',
      custom_role_id: role.id,
      added_by: owner.id,
    });
    expect(member.custom_role_id).toBeNull();
  });
});

describe('group grants', () => {
  it('reach listed members only — never the group creator by that fact alone (D12)', async () => {
    const w = await crm();
    const group = await db.groups.create({ name: 'Ops', created_by: groupOwner.id });
    await db.groups.addMembers(group.id, [sales.id], groupOwner.id);
    await db.tables.upsertBaseGroupGrant({
      base_id: w.base.id,
      group_id: group.id,
      role: 'editor',
      custom_role_id: null,
      added_by: owner.id,
    });

    expect(await db.tables.listGroupGrantsForUser(w.base.id, sales.id)).toEqual([
      expect.objectContaining({ group_id: group.id, role: 'editor', custom_role_id: null }),
    ]);
    expect(await db.tables.listGroupGrantsForUser(w.base.id, groupOwner.id)).toEqual([]);
    expect((await db.tables.listBasesForUser(sales.id)).map((base) => base.id)).toContain(w.base.id);
    expect((await db.tables.listBasesForUser(groupOwner.id)).map((base) => base.id)).not.toContain(w.base.id);

    const [listed] = await db.tables.listBaseGroupGrants(w.base.id);
    expect(listed).toMatchObject({
      group_id: group.id,
      group_name: 'Ops',
      group_created_by: groupOwner.id,
      group_creator_name: 'Group Owner',
      member_count: 1,
    });
    expect(await db.tables.removeBaseGroupGrant(w.base.id, group.id)).toBe(true);
    expect(await db.tables.listGroupGrantsForUser(w.base.id, sales.id)).toEqual([]);
  });

  it('carries the custom role position for the resolver', async () => {
    const w = await crm();
    await db.tables.createBaseRole({ base_id: w.base.id, name: 'First', rules: RULES, created_by: owner.id });
    const second = await db.tables.createBaseRole({
      base_id: w.base.id,
      name: 'Second',
      rules: RULES,
      created_by: owner.id,
    });
    const group = await db.groups.create({ name: 'Reps', created_by: owner.id });
    await db.groups.addMembers(group.id, [sales.id], owner.id);
    await db.tables.upsertBaseGroupGrant({
      base_id: w.base.id,
      group_id: group.id,
      role: 'custom',
      custom_role_id: second.id,
      added_by: owner.id,
    });
    expect(await db.tables.listGroupGrantsForBase(w.base.id)).toEqual([
      { user_id: sales.id, group_id: group.id, role: 'custom', custom_role_id: second.id, custom_role_position: 1 },
    ]);
  });
});

describe('owner transfer', () => {
  it('moves owner_id and rewrites both member rows in one go', async () => {
    const w = await crm();
    await db.tables.upsertBaseMember({ base_id: w.base.id, user_id: sales.id, role: 'viewer', added_by: owner.id });
    const moved = await db.tables.transferBaseOwner(w.base.id, {
      newOwnerId: sales.id,
      previousOwnerRole: 'editor',
      actorId: owner.id,
    });
    expect(moved?.owner_id).toBe(sales.id);
    expect((await db.tables.getBaseMember(w.base.id, sales.id))?.role).toBe('owner');
    expect((await db.tables.getBaseMember(w.base.id, owner.id))?.role).toBe('editor');

    await db.tables.transferBaseOwner(w.base.id, {
      newOwnerId: other.id,
      previousOwnerRole: 'remove',
      actorId: sales.id,
    });
    expect((await db.tables.getBase(w.base.id))?.owner_id).toBe(other.id);
    expect(await db.tables.getBaseMember(w.base.id, sales.id)).toBeUndefined();
  });
});

describe('access facts', () => {
  it('lists live tables, active fields with relation targets, and dependency edges', async () => {
    const w = await crm();
    const facts = await db.tables.loadAccessFacts(w.base.id);
    expect(facts.tables.map((table) => table.id)).toEqual([w.customers, w.orders]);
    expect(facts.fields.find((field) => field.id === w.fields.customer.id)).toMatchObject({
      tableId: w.orders,
      type: 'relation',
      relationTargetTableId: w.customers,
    });
    expect(facts.dependencies).toEqual(
      expect.arrayContaining([
        { fieldId: w.fields.commission.id, dependsOnFieldId: w.fields.amount.id },
        { fieldId: w.fields.total.id, dependsOnFieldId: w.fields.customer.id },
        { fieldId: w.fields.total.id, dependsOnFieldId: w.fields.amount.id },
      ]),
    );
    const customersScope = compileTableAccessScope(w.rules, w.customers, facts, sales.id)!;
    expect(customersScope.readableFieldIds).toEqual([w.fields.customerName.id, w.fields.rep.id]);
  });

  it('keeps a hidden source’s readers hidden after it is archived, and stops computing from it', async () => {
    const w = await crm();
    const order = await db.tables.createRecord(
      { table_id: w.orders, values: { [w.fields.orderNo.id]: 'O-1', [w.fields.customer.id]: w.theirs.id } },
      fullTableAccess(owner.id),
      meta(owner.id),
    );
    expect(order.computed_values[String(w.fields.total.id)]).toBe(9_000_000);
    expect(w.theirs.computed_values[String(w.fields.commission.id)]).toBe(900_000);
    // The formula and the rollup are visible only while Amount is: read them explicitly.
    const rules: TableAccessRules = {
      ...w.rules,
      tables: w.rules.tables.map((rule) => ({
        ...rule,
        rows: { type: 'all' },
        fields: [
          ...rule.fields,
          { fieldId: w.fields.commission.id, access: 'read' },
          { fieldId: w.fields.total.id, access: 'read' },
        ],
      })),
    };

    await db.tables.archiveField(w.fields.amount.id, owner.id);

    const facts = await db.tables.loadAccessFacts(w.base.id);
    expect(facts.dependencies).toEqual(
      expect.arrayContaining([
        { fieldId: w.fields.commission.id, dependsOnFieldId: w.fields.amount.id },
        { fieldId: w.fields.total.id, dependsOnFieldId: w.fields.amount.id },
      ]),
    );
    const customersScope = compileTableAccessScope(rules, w.customers, facts, sales.id)!;
    expect(customersScope.readableFieldIds).not.toContain(w.fields.commission.id);
    const ordersScope = compileTableAccessScope(rules, w.orders, facts, sales.id)!;
    expect(ordersScope.readableFieldIds).not.toContain(w.fields.total.id);

    // The archived column's stored values no longer feed the formula or the rollup.
    const theirs = await db.tables.getRecordById(w.theirs.id);
    expect(theirs!.values[String(w.fields.amount.id)]).toBe(9_000_000);
    expect(theirs!.computed_values[String(w.fields.commission.id)]).toBe(0);
    expect((await db.tables.getRecordById(order.id))!.computed_values[String(w.fields.total.id)]).toBe(0);
  });

  it('empties a rollup whose relation is archived', async () => {
    const w = await crm();
    const order = await db.tables.createRecord(
      { table_id: w.orders, values: { [w.fields.orderNo.id]: 'O-1', [w.fields.customer.id]: w.mine.id } },
      fullTableAccess(owner.id),
      meta(owner.id),
    );
    expect(order.computed_values[String(w.fields.total.id)]).toBe(100);
    await db.tables.archiveField(w.fields.customer.id, owner.id);
    expect((await db.tables.getRecordById(order.id))!.computed_values[String(w.fields.total.id)]).toBe(0);
  });
});

describe('scoped writes — relation targets (D14)', () => {
  it('links only to records inside the read rows of the target table', async () => {
    const w = await crm();
    const scope = await salesScope(w, w.orders);
    const order = await db.tables.createRecord(
      { table_id: w.orders, values: { [w.fields.orderNo.id]: 'O-1', [w.fields.customer.id]: w.mine.id } },
      scope,
      meta(sales.id),
    );
    await expect(
      db.tables.updateRecord(
        {
          table_id: w.orders,
          record_id: order.id,
          revision: order.revision,
          values: { [w.fields.customer.id]: w.theirs.id },
        },
        scope,
        meta(sales.id),
      ),
    ).rejects.toThrow('references an unavailable record');
    await expect(
      db.tables.createRecord(
        { table_id: w.orders, values: { [w.fields.orderNo.id]: 'O-2', [w.fields.customer.id]: w.theirs.id } },
        scope,
        meta(sales.id),
      ),
    ).rejects.toThrow('references an unavailable record');
    const validation = await db.tables.validateBatchRecords(
      {
        table_id: w.orders,
        items: [{ values: { [w.fields.orderNo.id]: 'O-3', [w.fields.customer.id]: w.theirs.id } }],
      },
      scope,
    );
    expect(validation).toEqual([
      expect.objectContaining({ ok: false, message: expect.stringContaining('unavailable record') }),
    ]);
    // The same message as a record that does not exist at all — no id oracle.
    await expect(
      db.tables.createRecord(
        { table_id: w.orders, values: { [w.fields.orderNo.id]: 'O-4', [w.fields.customer.id]: 999_999 } },
        scope,
        meta(sales.id),
      ),
    ).rejects.toThrow('references an unavailable record');
  });

  it('keeps a link someone else made while the writer edits another field', async () => {
    const w = await crm();
    const scope = await salesScope(w, w.orders);
    const order = await db.tables.createRecord(
      { table_id: w.orders, values: { [w.fields.orderNo.id]: 'O-1' } },
      scope,
      meta(sales.id),
    );
    const linked = await db.tables.updateRecord(
      {
        table_id: w.orders,
        record_id: order.id,
        revision: order.revision,
        values: { [w.fields.customer.id]: w.theirs.id },
      },
      fullTableAccess(owner.id),
      meta(owner.id),
    );
    expect(linked.ok).toBe(true);
    const edited = await db.tables.updateRecord(
      {
        table_id: w.orders,
        record_id: order.id,
        revision: order.revision + 1,
        values: { [w.fields.orderNo.id]: 'O-1b' },
      },
      scope,
      meta(sales.id),
    );
    expect(edited.ok).toBe(true);
  });

  it('accepts no new link at all when the target table is invisible to the role', async () => {
    const w = await crm();
    const ordersOnly = { ...w.rules, tables: w.rules.tables.filter((rule) => rule.tableId === w.orders) };
    const scope = compileTableAccessScope(ordersOnly, w.orders, await db.tables.loadAccessFacts(w.base.id), sales.id)!;
    expect(scope.editableFieldIds).not.toContain(w.fields.customer.id);
    // Even with the key forced editable, the missing target scope refuses it.
    await expect(
      db.tables.createRecord(
        { table_id: w.orders, values: { [w.fields.orderNo.id]: 'O', [w.fields.customer.id]: w.mine.id } },
        { ...scope, editableFieldIds: [...scope.editableFieldIds, w.fields.customer.id] },
        meta(sales.id),
      ),
    ).rejects.toThrow('references an unavailable record');
  });
});

describe('scoped writes — attachments (D15)', () => {
  it('accepts the writer’s own fresh uploads and the files already on the field, nothing else', async () => {
    const w = await crm();
    const scope = await salesScope(w, w.orders);
    const mineFile = await upload(w.base.id, sales, 'mine.pdf');
    const ownerFile = await upload(w.base.id, owner, 'contract.pdf');

    const order = await db.tables.createRecord(
      { table_id: w.orders, values: { [w.fields.orderNo.id]: 'O-1', [w.fields.files.id]: [mineFile.id] } },
      scope,
      meta(sales.id),
    );
    expect(await db.tables.listFileAttachments(mineFile.id)).toEqual([
      { record_id: order.id, field_id: w.fields.files.id, table_id: w.orders, deleted: false },
    ]);
    // Someone else's file: refused, with the generic message.
    await expect(
      db.tables.updateRecord(
        {
          table_id: w.orders,
          record_id: order.id,
          revision: order.revision,
          values: { [w.fields.files.id]: [mineFile.id, ownerFile.id] },
        },
        scope,
        meta(sales.id),
      ),
    ).rejects.toThrow('references an unavailable Base file');

    // A file another record already carries (the re-attach attack): refused.
    const hidden = await db.tables.createRecord(
      { table_id: w.orders, values: { [w.fields.orderNo.id]: 'Secret', [w.fields.files.id]: [ownerFile.id] } },
      fullTableAccess(owner.id),
      meta(owner.id),
    );
    expect(hidden.id).toBeGreaterThan(0);
    const second = await db.tables.createRecord(
      { table_id: w.orders, values: { [w.fields.orderNo.id]: 'O-2' } },
      scope,
      meta(sales.id),
    );
    await expect(
      db.tables.updateRecord(
        {
          table_id: w.orders,
          record_id: second.id,
          revision: second.revision,
          values: { [w.fields.files.id]: [mineFile.id] },
        },
        scope,
        meta(sales.id),
      ),
    ).rejects.toThrow('references an unavailable Base file');

    // Re-saving the field with what it already holds is fine.
    const kept = await db.tables.updateRecord(
      {
        table_id: w.orders,
        record_id: order.id,
        revision: order.revision,
        values: { [w.fields.files.id]: [mineFile.id] },
      },
      scope,
      meta(sales.id),
    );
    expect(kept.ok).toBe(true);
    // Full scopes (built-in roles) are not restricted.
    const builtIn = await db.tables.updateRecord(
      {
        table_id: w.orders,
        record_id: second.id,
        revision: second.revision,
        values: { [w.fields.files.id]: [ownerFile.id] },
      },
      fullTableAccess(owner.id),
      meta(owner.id),
    );
    expect(builtIn.ok).toBe(true);
  });
});
