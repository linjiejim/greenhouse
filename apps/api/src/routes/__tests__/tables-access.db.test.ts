/**
 * Tables access control end to end (Phase 0 slice A, real PostgreSQL), through
 * the HTTP routes, Drive and the Agent tools — spec acceptance 1–3:
 *
 * 1. a group grant opens a Base; a direct member row overrides it; groups never
 *    hold builder; a group's creator who is not a member gets nothing;
 * 2. the custom role 销售 (customers: read, own rows, amount hidden; orders:
 *    edit own rows) sees no out-of-scope row and no hidden column on any path —
 *    grid query, aggregate, export_data, tables_query / tables_mutation, record
 *    get, recipients, attachments, dashboards, views, forms — and every oracle
 *    on a hidden field is refused;
 * 3. a referenced role cannot be deleted (409), and a dangling custom grant
 *    resolves to no access, never viewer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { TableAccessRules, TableBaseAccessView } from '@greenhouse/types/table-access';
import type { AppEnv } from '../../app-env.js';
import tablesRoutes from '../tables/index.js';
import driveRoutes from '../drive.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { canRecipientRead } from '../../platform/tables/access.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { createExportDataTool } from '../../tools/export-data.js';
import { createTablesMutationTool } from '../../tools/tables-mutation.js';
import { createTablesQueryTool } from '../../tools/tables-query.js';
import { deleteObjectAtKey, getObjectAtKey } from '../../storage/uploads.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let sales: UserRow;
let other: UserRow;
let groupOwner: UserRow;
let users: UserRow[];

function createApp() {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const user = users.find((entry) => entry.id === c.req.header('x-test-user'));
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  app.route('/api/tables', tablesRoutes);
  app.route('/api/drive', driveRoutes);
  return app;
}

let app: ReturnType<typeof createApp>;

function send(user: UserRow, path: string, method = 'GET', body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': user.id },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as T;
}

async function executeTool(tool: unknown, input: unknown): Promise<Record<string, unknown>> {
  const executable = tool as {
    execute: (value: unknown, options: { toolCallId: string; messages: never[] }) => Promise<unknown>;
  };
  return (await executable.execute(input, { toolCallId: 'tables-access-test', messages: [] })) as Record<
    string,
    unknown
  >;
}

interface Field {
  id: number;
}
interface RecordView {
  id: number;
  revision: number;
  values: Record<string, unknown>;
  computed_values: Record<string, unknown>;
}

async function createField(tableId: number, name: string, type: string, config?: unknown): Promise<Field> {
  return (
    await json<{ field: Field }>(
      await send(owner, `/api/tables/tables/${tableId}/fields`, 'POST', { name, type, config }),
      201,
    )
  ).field;
}

async function createRecord(user: UserRow, tableId: number, values: Record<string, unknown>) {
  return send(user, `/api/tables/tables/${tableId}/records`, 'POST', { values });
}

/** Upload through Drive as `user` (local storage: init → proxy PUT). */
async function upload(user: UserRow, baseId: number, name: string) {
  const init = await json<{ file_id: number; upload_url: string }>(
    await send(user, '/api/drive/files/init', 'POST', { scope: 'tables', base_id: baseId, name, size: 5 }),
  );
  const put = await app.request(init.upload_url, {
    method: 'PUT',
    headers: { 'x-test-user': user.id },
    body: 'bytes',
  });
  expect(put.status).toBe(200);
  return init.file_id;
}

/** The acceptance example: 客户 + 订单, the 销售 role, and a table the role never sees. */
async function crm() {
  const created = await json<{ base: { id: number }; schema: { table: { id: number }; fields: Field[] } }>(
    await send(owner, '/api/tables/bases', 'POST', { name: 'CRM', defaultTableName: 'Customers' }),
    201,
  );
  const baseId = created.base.id;
  const customers = created.schema.table.id;
  const customerName = created.schema.fields[0]!;
  const amount = await createField(customers, 'Contract amount', 'number');
  const rep = await createField(customers, 'Rep', 'user');
  const note = await createField(customers, 'Note', 'long_text');
  const commission = await createField(customers, 'Commission', 'formula', {
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
  const shout = await createField(customers, 'Shout', 'formula', {
    formula: { resultType: 'text', expression: { type: 'field', fieldId: customerName.id } },
  });
  const ordersSchema = await json<{ table: { id: number }; fields: Field[] }>(
    await send(owner, `/api/tables/bases/${baseId}/tables`, 'POST', { name: 'Orders' }),
    201,
  );
  const orders = ordersSchema.table.id;
  const orderNo = ordersSchema.fields[0]!;
  const customer = await createField(orders, 'Customer', 'relation', { relation: { targetTableId: customers } });
  const customerAmount = await createField(orders, 'Customer amount', 'rollup', {
    rollup: { relationFieldId: customer.id, targetFieldId: amount.id, aggregation: 'sum' },
  });
  const files = await createField(orders, 'Files', 'attachment');
  const secrets = (
    await json<{ table: { id: number }; fields: Field[] }>(
      await send(owner, `/api/tables/bases/${baseId}/tables`, 'POST', { name: 'Secrets' }),
      201,
    )
  ).table.id;

  const mine = (
    await json<{ record: RecordView }>(
      await createRecord(owner, customers, {
        [customerName.id]: 'Mine Co',
        [amount.id]: 100,
        [rep.id]: sales.id,
        [note.id]: 'needle',
      }),
      201,
    )
  ).record;
  const theirs = (
    await json<{ record: RecordView }>(
      await createRecord(owner, customers, {
        [customerName.id]: 'Theirs Co',
        [amount.id]: 9_000_000,
        [rep.id]: other.id,
      }),
      201,
    )
  ).record;
  const ownerFile = await upload(owner, baseId, 'contract.pdf');
  const ownerOrder = (
    await json<{ record: RecordView }>(
      await createRecord(owner, orders, {
        [orderNo.id]: 'O-owner',
        [customer.id]: theirs.id,
        [files.id]: [ownerFile],
      }),
      201,
    )
  ).record;

  const rules: TableAccessRules = {
    version: 1,
    dashboards: 'all',
    tables: [
      {
        tableId: customers,
        access: 'read',
        rows: { type: 'related', creator: false, fieldIds: [rep.id] },
        fields: [
          { fieldId: amount.id, access: 'hidden' },
          { fieldId: note.id, access: 'hidden' },
        ],
        fieldDefault: 'visible',
      },
      {
        tableId: orders,
        access: 'edit',
        rows: { type: 'related', creator: true, fieldIds: [] },
        fields: [],
        fieldDefault: 'visible',
      },
    ],
  };
  const role = (
    await json<{ role: { id: number; revision: number } }>(
      await send(owner, `/api/tables/bases/${baseId}/roles`, 'POST', { name: '销售', rules }),
      201,
    )
  ).role;
  await json(
    await send(owner, `/api/tables/bases/${baseId}/members/${sales.id}`, 'PUT', {
      role: 'custom',
      customRoleId: role.id,
    }),
  );
  return {
    baseId,
    customers,
    orders,
    secrets,
    role,
    rules,
    fields: { customerName, amount, rep, note, commission, shout, orderNo, customer, customerAmount, files },
    mine,
    theirs,
    ownerOrder,
    ownerFile,
  };
}

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  [owner, sales, other, groupOwner] = await Promise.all([
    createInternalTestUser(db, { email: `tables-acc-owner-${tag}@test.local`, nickname: 'Owner' }),
    createInternalTestUser(db, { email: `tables-acc-sales-${tag}@test.local`, nickname: 'Sales' }),
    createInternalTestUser(db, { email: `tables-acc-other-${tag}@test.local`, nickname: 'Other' }),
    createInternalTestUser(db, { email: `tables-acc-gowner-${tag}@test.local`, nickname: 'Group owner' }),
  ]);
  users = [owner, sales, other, groupOwner];
  initializePlatformRuntime(db, [tablesRegistration]);
  app = createApp();
});

afterEach(async () => {
  resetPlatformRuntimeForTests();
  await db.close();
  _resetProvider();
});

describe('acceptance 1 — group grants', { timeout: 30_000 }, () => {
  it('opens a Base to a group, lets a direct row override it, and never grants builder', async () => {
    const base = await json<{ base: { id: number }; schema: { table: { id: number }; fields: Field[] } }>(
      await send(owner, '/api/tables/bases', 'POST', { name: 'Group Base' }),
      201,
    );
    const baseId = base.base.id;
    const tableId = base.schema.table.id;
    const primary = base.schema.fields[0]!.id;
    const group = await db.groups.create({ name: 'Editors', created_by: owner.id });
    await db.groups.addMembers(group.id, [sales.id], owner.id);

    expect(
      (await send(owner, `/api/tables/bases/${baseId}/groups/${group.id}`, 'PUT', { role: 'builder' })).status,
    ).toBe(400);
    const granted = await json<{ group: { groupId: number; role: string; memberCount: number; managedBy: unknown } }>(
      await send(owner, `/api/tables/bases/${baseId}/groups/${group.id}`, 'PUT', { role: 'editor' }),
    );
    expect(granted.group).toMatchObject({
      groupId: group.id,
      role: 'editor',
      memberCount: 1,
      managedBy: { id: owner.id },
    });

    const listed = await json<{ bases: Array<{ id: number; role: string }> }>(await send(sales, '/api/tables/bases'));
    expect(listed.bases).toContainEqual(expect.objectContaining({ id: baseId, role: 'editor' }));
    expect((await createRecord(sales, tableId, { [primary]: 'Via group' })).status).toBe(201);

    // The person's own row wins, even when it is lower than the group's.
    await json(await send(owner, `/api/tables/bases/${baseId}/members/${sales.id}`, 'PUT', { role: 'viewer' }));
    expect((await json<{ role: string }>(await send(sales, `/api/tables/bases/${baseId}`))).role).toBe('viewer');
    expect((await createRecord(sales, tableId, { [primary]: 'Blocked' })).status).toBe(404);

    // Removing the group grant takes the group path away; the member row stays.
    await json(await send(owner, `/api/tables/bases/${baseId}/members/${sales.id}`, 'DELETE'));
    await json(await send(owner, `/api/tables/bases/${baseId}/groups/${group.id}`, 'DELETE'));
    expect((await send(sales, `/api/tables/bases/${baseId}`)).status).toBe(404);
  });

  it('refuses groups the granter cannot see, and gives a non-member group creator nothing (D12)', async () => {
    const base = await json<{ base: { id: number } }>(
      await send(owner, '/api/tables/bases', 'POST', { name: 'Delegated' }),
      201,
    );
    const baseId = base.base.id;
    const foreign = await db.groups.create({ name: 'Not yours', created_by: groupOwner.id });
    expect(
      (await send(owner, `/api/tables/bases/${baseId}/groups/${foreign.id}`, 'PUT', { role: 'viewer' })).status,
    ).toBe(404);
    expect((await send(owner, `/api/tables/bases/${baseId}/groups/999999`, 'PUT', { role: 'viewer' })).status).toBe(
      404,
    );

    // The owner belongs to the group, so may grant it; its creator is not listed.
    await db.groups.addMembers(foreign.id, [owner.id, sales.id], groupOwner.id);
    await json(await send(owner, `/api/tables/bases/${baseId}/groups/${foreign.id}`, 'PUT', { role: 'viewer' }));
    expect((await send(sales, `/api/tables/bases/${baseId}`)).status).toBe(200);
    expect((await send(groupOwner, `/api/tables/bases/${baseId}`)).status).toBe(404);
    const creatorBases = await json<{ bases: Array<{ id: number }> }>(await send(groupOwner, '/api/tables/bases'));
    expect(creatorBases.bases.map((entry) => entry.id)).not.toContain(baseId);

    // Only the owner manages grants.
    expect(
      (await send(sales, `/api/tables/bases/${baseId}/groups/${foreign.id}`, 'PUT', { role: 'editor' })).status,
    ).toBe(404);
  });

  it('shows grants to members and roles to the owner only', async () => {
    const w = await crm();
    const group = await db.groups.create({ name: 'Viewers', created_by: owner.id });
    await db.groups.addMembers(group.id, [other.id], owner.id);
    await json(await send(owner, `/api/tables/bases/${w.baseId}/groups/${group.id}`, 'PUT', { role: 'viewer' }));

    const forOwner = await json<{
      members: Array<{ user_id: string; name: string }>;
      groups: unknown[];
      roles?: unknown[];
    }>(await send(owner, `/api/tables/bases/${w.baseId}/members`));
    expect(forOwner.roles).toHaveLength(1);
    expect(forOwner.groups).toHaveLength(1);
    expect(forOwner.members).toContainEqual(expect.objectContaining({ user_id: sales.id, name: 'Sales' }));
    const forViewer = await json<{ roles?: unknown[] }>(await send(other, `/api/tables/bases/${w.baseId}/members`));
    expect(forViewer.roles).toBeUndefined();
    // A custom role learns names through getBase only.
    expect((await send(sales, `/api/tables/bases/${w.baseId}/members`)).status).toBe(404);
    expect((await send(sales, `/api/tables/bases/${w.baseId}/roles`)).status).toBe(404);
  });
});

describe('acceptance 2 — the 销售 custom role', { timeout: 30_000 }, () => {
  it('sees only its tables, readable fields and compiled access in the workspace and schema', async () => {
    const w = await crm();
    const workspace = await json<{
      role: string;
      access: TableBaseAccessView;
      tables: Array<{ id: number }>;
      members: Array<Record<string, unknown>>;
    }>(await send(sales, `/api/tables/bases/${w.baseId}`));
    expect(workspace.role).toBe('viewer');
    expect(workspace.access.level).toBe('custom');
    expect(workspace.access.customRole).toEqual({ id: w.role.id, name: '销售' });
    expect(workspace.access.rules).toBeUndefined();
    expect(workspace.tables.map((table) => table.id)).toEqual([w.customers, w.orders]);
    expect(workspace.members.every((member) => Object.keys(member).sort().join() === 'id,name')).toBe(true);
    const customersView = workspace.access.tables!.find((table) => table.tableId === w.customers)!;
    expect(customersView).toEqual({
      tableId: w.customers,
      access: 'read',
      readableFieldIds: [w.fields.customerName.id, w.fields.rep.id, w.fields.shout.id],
      editableFieldIds: [],
      canCreate: false,
      canDelete: false,
    });

    const tables = await json<{ tables: Array<{ id: number }> }>(
      await send(sales, `/api/tables/bases/${w.baseId}/tables`),
    );
    expect(tables.tables.map((table) => table.id)).not.toContain(w.secrets);
    const schema = await json<{ fields: Field[] }>(await send(sales, `/api/tables/tables/${w.customers}/schema`));
    expect(schema.fields.map((field) => field.id)).toEqual([
      w.fields.customerName.id,
      w.fields.rep.id,
      w.fields.shout.id,
    ]);
    const orders = await json<{ fields: Field[] }>(await send(sales, `/api/tables/tables/${w.orders}/schema`));
    // The rollup over the hidden amount is hidden too (D4 closure).
    expect(orders.fields.map((field) => field.id)).not.toContain(w.fields.customerAmount.id);
    expect((await send(sales, `/api/tables/tables/${w.secrets}/schema`)).status).toBe(404);
    expect((await send(sales, `/api/tables/tables/${w.customers}/schema/versions`)).status).toBe(404);
  });

  it('reads only its rows and readable values on query, record get, aggregate and recipients', async () => {
    const w = await crm();
    const query = await json<{ records: RecordView[]; total: number }>(
      await send(sales, `/api/tables/tables/${w.customers}/records/query`, 'POST', {}),
    );
    expect(query.total).toBe(1);
    expect(query.records[0]!.id).toBe(w.mine.id);
    const hidden = [w.fields.amount.id, w.fields.note.id, w.fields.commission.id].map(String);
    for (const key of hidden) {
      expect(query.records[0]!.values).not.toHaveProperty(key);
      expect(query.records[0]!.computed_values).not.toHaveProperty(key);
    }
    expect(query.records[0]!.computed_values[String(w.fields.shout.id)]).toBe('Mine Co');

    expect((await send(sales, `/api/tables/tables/${w.customers}/records/${w.theirs.id}`)).status).toBe(404);
    const record = await json<{ record: RecordView }>(
      await send(sales, `/api/tables/tables/${w.customers}/records/${w.mine.id}`),
    );
    expect(record.record.values).not.toHaveProperty(String(w.fields.amount.id));
    expect((await send(sales, `/api/tables/tables/${w.secrets}/records/query`, 'POST', {})).status).toBe(404);

    // Recipients: the out-of-scope row skips the person, the in-scope row carries the readable fields only.
    expect(await canRecipientRead({ db }, sales.id, { id: w.theirs.id, table_id: w.customers })).toBeNull();
    const recipient = await canRecipientRead({ db }, sales.id, { id: w.mine.id, table_id: w.customers });
    expect(recipient?.via).toBe('base');
    expect(recipient?.scope.kind === 'scoped' && recipient.scope.readableFieldIds).toEqual([
      w.fields.customerName.id,
      w.fields.rep.id,
      w.fields.shout.id,
    ]);
  });

  it('refuses every query oracle on a hidden field', async () => {
    const w = await crm();
    const amount = w.fields.amount.id;
    const queryAs = (query: unknown) => send(sales, `/api/tables/tables/${w.customers}/records/query`, 'POST', query);
    const clause = { fieldId: amount, operator: 'gt', value: 1 };
    expect((await queryAs({ where: { combinator: 'and', clauses: [clause] } })).status).toBe(400);
    expect((await queryAs({ filters: [{ combinator: 'and', clauses: [clause] }] })).status).toBe(400);
    expect((await queryAs({ sort: [{ fieldId: amount, direction: 'desc' }] })).status).toBe(400);
    expect((await queryAs({ groupBy: { fieldId: amount } })).status).toBe(400);
    expect(
      (
        await queryAs({
          where: { combinator: 'and', clauses: [{ fieldId: w.fields.commission.id, operator: 'gt', value: 1 }] },
        })
      ).status,
    ).toBe(400);
    // The same refusal as a field that does not exist at all.
    const missing = await queryAs({
      where: { combinator: 'and', clauses: [{ fieldId: 999_999, operator: 'gt', value: 1 }] },
    });
    const hiddenRefusal = await queryAs({ where: { combinator: 'and', clauses: [clause] } });
    expect((await hiddenRefusal.json()).error.replace(String(amount), '#')).toBe(
      (await missing.json()).error.replace('999999', '#'),
    );
    // Search only looks at readable text: the hidden note never matches.
    const searched = await json<{ total: number }>(await queryAs({ search: 'needle' }));
    expect(searched.total).toBe(0);

    const tool = createTablesQueryTool({ userId: sales.id });
    const sum = await executeTool(tool, {
      action: 'records.aggregate',
      table_id: w.customers,
      operation: 'sum',
      value_field_id: amount,
    });
    expect(sum.error).toBeDefined();
    const grouped = await executeTool(tool, {
      action: 'records.aggregate',
      table_id: w.customers,
      operation: 'count',
      group_by_field_id: amount,
    });
    expect(grouped.error).toBeDefined();
    const counted = (await executeTool(tool, { action: 'records.aggregate', table_id: w.customers })) as {
      rows: Array<{ value: number }>;
    };
    expect(counted.rows).toEqual([expect.objectContaining({ value: 1 })]);
  });

  it('applies the same scope to tables_query, tables_mutation and export_data', async () => {
    const w = await crm();
    const query = createTablesQueryTool({ userId: sales.id });
    const listed = (await executeTool(query, { action: 'records.query', table_id: w.customers })) as {
      records: RecordView[];
    };
    expect(listed.records.map((record) => record.id)).toEqual([w.mine.id]);
    expect(listed.records[0]!.values).not.toHaveProperty(String(w.fields.amount.id));
    const schema = (await executeTool(query, { action: 'schema.get', table_id: w.customers })) as { fields: Field[] };
    expect(schema.fields.map((field) => field.id)).not.toContain(w.fields.amount.id);
    expect(
      (await executeTool(query, { action: 'records.get', table_id: w.customers, record_id: w.theirs.id })).error,
    ).toBeDefined();
    const base = (await executeTool(query, { action: 'base.get', base_id: w.baseId })) as { tables: Field[] };
    expect(base.tables.map((table) => table.id)).not.toContain(w.secrets);

    const mutation = createTablesMutationTool({ userId: sales.id });
    expect(
      (
        await executeTool(mutation, {
          action: 'records.update',
          table_id: w.customers,
          record_id: w.mine.id,
          revision: w.mine.revision,
          values: { [w.fields.customerName.id]: 'Renamed' },
        })
      ).error,
    ).toBeDefined();
    expect(
      (
        await executeTool(mutation, {
          action: 'records.create',
          table_id: w.orders,
          values: { [w.fields.orderNo.id]: 'O-agent', [w.fields.customer.id]: w.theirs.id },
        })
      ).error,
    ).toMatch(/unavailable record/);
    const created = (await executeTool(mutation, {
      action: 'records.create',
      table_id: w.orders,
      values: { [w.fields.orderNo.id]: 'O-agent', [w.fields.customer.id]: w.mine.id },
    })) as { record: RecordView };
    expect(created.record.id).toBeGreaterThan(0);

    const session = await db.sessions.create('Sales export', 'team', sales.id);
    const artifact = (await executeTool(createExportDataTool(db, { userId: sales.id, sessionId: session.id }), {
      source: { type: 'tables_records', table_id: w.customers },
      format: 'csv',
    })) as { file_id: string; row_count: number };
    expect(artifact.row_count).toBe(1);
    const file = await db.chatFiles.getById(artifact.file_id);
    const csv = (await getObjectAtKey(file!.storage_key))!.buffer.toString('utf8');
    expect(csv).toContain('Mine Co');
    expect(csv).not.toContain('Theirs Co');
    expect(csv).not.toContain('Contract amount');
    expect(csv).not.toContain('9000000');
    await deleteObjectAtKey(file!.storage_key);
    const denied = await executeTool(createExportDataTool(db, { userId: sales.id, sessionId: session.id }), {
      source: { type: 'tables_records', table_id: w.secrets },
      format: 'csv',
    });
    expect(denied.error).toMatch(/not found/i);
  });

  it('writes only inside its edit rows, editable fields and readable relation targets (D14)', async () => {
    const w = await crm();
    // A read rule never writes, and an out-of-scope id is a 404 like a missing one.
    const renameMine = await send(sales, `/api/tables/tables/${w.customers}/records/${w.mine.id}`, 'PATCH', {
      revision: w.mine.revision,
      values: { [w.fields.customerName.id]: 'x' },
    });
    expect(renameMine.status).toBe(404);
    expect(
      (
        await send(sales, `/api/tables/tables/${w.orders}/records/${w.ownerOrder.id}`, 'PATCH', {
          revision: w.ownerOrder.revision,
          values: { [w.fields.orderNo.id]: 'x' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await send(
          sales,
          `/api/tables/tables/${w.orders}/records/${w.ownerOrder.id}?revision=${w.ownerOrder.revision}`,
          'DELETE',
        )
      ).status,
    ).toBe(404);

    expect(
      (await createRecord(sales, w.orders, { [w.fields.orderNo.id]: 'O-1', [w.fields.customer.id]: w.theirs.id }))
        .status,
    ).toBe(400);
    const order = (
      await json<{ record: RecordView }>(
        await createRecord(sales, w.orders, { [w.fields.orderNo.id]: 'O-1', [w.fields.customer.id]: w.mine.id }),
        201,
      )
    ).record;
    // Retargeting to a customer it cannot see — the "change the link, read the rollup" leak — is refused.
    const retarget = await send(sales, `/api/tables/tables/${w.orders}/records/${order.id}`, 'PATCH', {
      revision: order.revision,
      values: { [w.fields.customer.id]: w.theirs.id },
    });
    expect(retarget.status).toBe(400);
    expect((await retarget.json()).error).toMatch(/unavailable record/);
    // Hidden / computed keys are not writable: 403 with the reason.
    const computedWrite = await send(sales, `/api/tables/tables/${w.orders}/records/${order.id}`, 'PATCH', {
      revision: order.revision,
      values: { [w.fields.customerAmount.id]: 1 },
    });
    expect(computedWrite.status).toBe(403);
    // The rollup over the hidden amount never comes back.
    const reread = await json<{ record: RecordView }>(
      await send(sales, `/api/tables/tables/${w.orders}/records/${order.id}`),
    );
    expect(reread.record.computed_values).not.toHaveProperty(String(w.fields.customerAmount.id));
    const batch = await json<{ results: Array<{ ok: boolean; reason?: string }> }>(
      await send(sales, `/api/tables/tables/${w.orders}/records/batch-validate`, 'POST', {
        items: [
          { record_id: w.ownerOrder.id, revision: w.ownerOrder.revision, values: { [w.fields.orderNo.id]: 'x' } },
        ],
      }),
    );
    expect(batch.results).toEqual([expect.objectContaining({ ok: false, reason: 'not_found' })]);
  });

  it('keeps attachments of hidden records out of reach and accepts only its own uploads (D15)', async () => {
    const w = await crm();
    // The cabinet is closed to a custom role.
    expect((await send(sales, `/api/drive/files?scope=tables&base_id=${w.baseId}`)).status).toBe(403);
    expect((await send(sales, `/api/drive/folders?scope=tables&base_id=${w.baseId}`)).status).toBe(403);
    // A file on a record outside its rows cannot be downloaded, deleted or re-attached.
    expect((await send(sales, `/api/drive/files/${w.ownerFile}/content`)).status).toBe(403);
    expect((await send(sales, `/api/drive/files/${w.ownerFile}`, 'DELETE')).status).toBe(403);
    const order = (
      await json<{ record: RecordView }>(await createRecord(sales, w.orders, { [w.fields.orderNo.id]: 'O-files' }), 201)
    ).record;
    const reattach = await send(sales, `/api/tables/tables/${w.orders}/records/${order.id}`, 'PATCH', {
      revision: order.revision,
      values: { [w.fields.files.id]: [w.ownerFile] },
    });
    expect(reattach.status).toBe(400);
    expect((await reattach.json()).error).toMatch(/unavailable Base file/);

    // Its own upload: attachable, then readable through the record.
    const own = await upload(sales, w.baseId, 'mine.pdf');
    expect((await send(sales, `/api/drive/files/${own}/content`)).status).toBe(200);
    const attached = await send(sales, `/api/tables/tables/${w.orders}/records/${order.id}`, 'PATCH', {
      revision: order.revision,
      values: { [w.fields.files.id]: [own] },
    });
    expect(attached.status).toBe(200);
    expect((await send(sales, `/api/drive/files/${own}/content`)).status).toBe(200);
    // Attached now: the uploader may no longer delete it; the owner (builder+) may.
    expect((await send(sales, `/api/drive/files/${own}`, 'DELETE')).status).toBe(403);
    // A finished upload's bytes are never replaced — not even by its uploader.
    const overwrite = await app.request(`/api/drive/files/${own}/content`, {
      method: 'PUT',
      headers: { 'x-test-user': sales.id },
      body: 'other bytes',
    });
    expect(overwrite.status).toBe(403);
    // The owner still reads every file of the Base.
    expect((await send(owner, `/api/drive/files/${w.ownerFile}/content`)).status).toBe(200);

    // A role that cannot edit any attachment field cannot upload at all.
    const readOnly = await json<{ role: { id: number } }>(
      await send(owner, `/api/tables/bases/${w.baseId}/roles`, 'POST', {
        name: 'Reader',
        rules: { ...w.rules, tables: [w.rules.tables[0]] },
      }),
      201,
    );
    await json(
      await send(owner, `/api/tables/bases/${w.baseId}/members/${other.id}`, 'PUT', {
        role: 'custom',
        customRoleId: readOnly.role.id,
      }),
    );
    expect(
      (
        await send(other, '/api/drive/files/init', 'POST', {
          scope: 'tables',
          base_id: w.baseId,
          name: 'x.pdf',
          size: 1,
        })
      ).status,
    ).toBe(403);
  });

  it('trims views, forms and dashboards, and closes dashboards when the rules say none', async () => {
    const w = await crm();
    const amount = w.fields.amount.id;
    const view = await json<{ view: { id: number } }>(
      await send(owner, `/api/tables/tables/${w.customers}/views`, 'POST', {
        name: 'Big deals',
        scope: 'shared',
        config: {
          fieldIds: [w.fields.customerName.id, amount],
          widths: { [amount]: 120, [w.fields.customerName.id]: 200 },
          query: {
            where: { combinator: 'and', clauses: [{ fieldId: amount, operator: 'gt', value: 1_000_000 }] },
            sort: [{ fieldId: amount, direction: 'desc' }],
          },
        },
      }),
      201,
    );
    const views = await json<{ views: Array<{ id: number; config: string }> }>(
      await send(sales, `/api/tables/tables/${w.customers}/views`),
    );
    const trimmed = views.views.find((entry) => entry.id === view.view.id)!;
    // Nothing in the trimmed config may name the hidden field: not as a column, a width key or a predicate.
    const trimmedConfig = JSON.parse(trimmed.config) as {
      fieldIds?: number[];
      widths?: Record<string, number>;
      query?: { where?: { clauses: Array<{ fieldId?: number }> }; sort?: Array<{ fieldId?: number }> };
    };
    expect(trimmedConfig.fieldIds).toEqual([w.fields.customerName.id]);
    expect(Object.keys(trimmedConfig.widths ?? {})).not.toContain(String(amount));
    expect((trimmedConfig.query?.where?.clauses ?? []).map((clause) => clause.fieldId)).not.toContain(amount);
    expect((trimmedConfig.query?.sort ?? []).map((sort) => sort.fieldId)).not.toContain(amount);
    expect((await send(sales, `/api/tables/tables/${w.secrets}/views`)).status).toBe(404);

    // Forms: only on tables the role may create in, and only its editable fields.
    const createForm = async (tableId: number, fieldIds: number[]) =>
      (
        await json<{ form: { id: number } }>(
          await send(owner, `/api/tables/tables/${tableId}/forms`, 'POST', {
            name: `Form ${tableId}`,
            config: { fieldIds },
          }),
          201,
        )
      ).form.id;
    const ordersForm = await createForm(w.orders, [w.fields.orderNo.id, w.fields.customer.id]);
    const customersForm = await createForm(w.customers, [w.fields.customerName.id, amount]);
    const opened = await json<{ fields: Field[] }>(await send(sales, `/api/tables/forms/${ordersForm}`));
    expect(opened.fields.map((field) => field.id)).toEqual([w.fields.orderNo.id, w.fields.customer.id]);
    expect((await send(sales, `/api/tables/forms/${customersForm}`)).status).toBe(404);

    const dashboard = (
      await json<{ dashboard: { id: number } }>(
        await send(owner, `/api/tables/bases/${w.baseId}/dashboards`, 'POST', {
          name: 'Pipeline',
          config: {
            version: 1,
            filters: [
              {
                id: 'note',
                label: 'Internal note',
                kind: 'search',
                targets: [{ tableId: w.customers, fieldId: w.fields.note.id }],
                defaultValue: { kind: 'search', text: 'VIP' },
              },
              {
                id: 'name',
                label: 'Name',
                kind: 'search',
                targets: [
                  { tableId: w.customers, fieldId: w.fields.customerName.id },
                  { tableId: w.customers, fieldId: w.fields.note.id },
                ],
              },
            ],
          },
        }),
        201,
      )
    ).dashboard;
    // Every path that hands out the dashboard row cuts its filters the same way:
    // no control, target or default value on a hidden field (spec §1).
    type DashboardRow = {
      id: number;
      config: { filters?: Array<{ id: string; targets: Array<{ fieldId?: number }> }> };
    };
    const listed = await json<{ dashboards: DashboardRow[] }>(
      await send(sales, `/api/tables/bases/${w.baseId}/dashboards`),
    );
    const inWorkspace = await json<{ dashboards: DashboardRow[] }>(await send(sales, `/api/tables/bases/${w.baseId}`));
    const single = await json<{ dashboard: DashboardRow }>(await send(sales, `/api/tables/dashboards/${dashboard.id}`));
    const viaTool = await executeTool(createTablesQueryTool({ userId: sales.id }), {
      action: 'dashboards.list',
      base_id: w.baseId,
    });
    expect(viaTool.error).toBeUndefined();
    for (const row of [
      listed.dashboards.find((entry) => entry.id === dashboard.id)!,
      inWorkspace.dashboards.find((entry) => entry.id === dashboard.id)!,
      single.dashboard,
    ]) {
      expect(row.config.filters).toEqual([
        {
          id: 'name',
          label: 'Name',
          kind: 'search',
          targets: [{ tableId: w.customers, fieldId: w.fields.customerName.id }],
        },
      ]);
    }
    expect(JSON.stringify(viaTool)).not.toContain('VIP');
    expect(JSON.stringify(viaTool)).not.toContain('Internal note');
    expect(JSON.stringify(viaTool)).toContain('Name');
    const ownerList = await json<{ dashboards: DashboardRow[] }>(
      await send(owner, `/api/tables/bases/${w.baseId}/dashboards`),
    );
    expect(ownerList.dashboards.find((entry) => entry.id === dashboard.id)!.config.filters).toHaveLength(2);
    const widget = async (type: string, tableId: number, config: unknown) =>
      (
        await json<{ widget: { id: number } }>(
          await send(owner, `/api/tables/dashboards/${dashboard.id}/widgets`, 'POST', {
            title: type,
            type,
            tableId,
            config,
          }),
          201,
        )
      ).widget.id;
    const sum = await widget('kpi', w.customers, { operation: 'sum', valueFieldId: amount });
    const count = await widget('kpi', w.customers, { operation: 'count' });
    const secret = await widget('records', w.secrets, {});

    // Widgets the role cannot evaluate come back as a bare frame flagged no_access (slice D's card contract).
    const seen = await json<{ widgets: Array<{ id: number; config: string; access?: 'no_access' }> }>(
      await send(sales, `/api/tables/dashboards/${dashboard.id}`),
    );
    const sumWidget = seen.widgets.find((entry) => entry.id === sum)!;
    expect(sumWidget.access).toBe('no_access');
    expect(JSON.parse(sumWidget.config)).not.toHaveProperty('card');
    expect(seen.widgets.find((entry) => entry.id === secret)?.access).toBe('no_access');
    expect(seen.widgets.find((entry) => entry.id === count)?.access).toBeUndefined();
    const sumResult = await json<{ result: { kind: string; value?: number } }>(
      await send(sales, `/api/tables/dashboard-widgets/${sum}/query`, 'POST'),
    );
    expect(sumResult.result).toEqual({ kind: 'no_access' });
    const countResult = await json<{ result: { kind: string; value?: number } }>(
      await send(sales, `/api/tables/dashboard-widgets/${count}/query`, 'POST'),
    );
    expect(countResult.result).toEqual({ kind: 'kpi', value: 1 });

    // dashboards: 'none' → the dashboards are not there at all.
    const current = await json<{ roles: Array<{ id: number; revision: number }> }>(
      await send(owner, `/api/tables/bases/${w.baseId}/roles`),
    );
    const revision = current.roles.find((role) => role.id === w.role.id)!.revision;
    await json(
      await send(owner, `/api/tables/roles/${w.role.id}`, 'PATCH', {
        revision,
        rules: { ...w.rules, dashboards: 'none' },
      }),
    );
    expect(
      (await json<{ dashboards: unknown[] }>(await send(sales, `/api/tables/bases/${w.baseId}`))).dashboards,
    ).toEqual([]);
    expect((await send(sales, `/api/tables/bases/${w.baseId}/dashboards`)).status).toBe(404);
    expect((await send(sales, `/api/tables/dashboards/${dashboard.id}`)).status).toBe(404);
    expect((await send(sales, `/api/tables/dashboard-widgets/${count}/query`, 'POST')).status).toBe(404);
  });
});

describe('acceptance 3 — references fail closed', { timeout: 30_000 }, () => {
  it('refuses to delete a role still in use and validates role ids against the Base', async () => {
    const w = await crm();
    const deleted = await send(owner, `/api/tables/roles/${w.role.id}`, 'DELETE');
    expect(deleted.status).toBe(409);
    expect(await deleted.json()).toMatchObject({
      error: 'role_in_use',
      details: { reason: 'role_in_use', references: { users: 1, groups: 0, team: false } },
    });

    await json(
      await send(owner, `/api/tables/bases/${w.baseId}`, 'PATCH', {
        visibility: 'team',
        teamRole: 'custom',
        teamCustomRoleId: w.role.id,
      }),
    );
    await json(await send(owner, `/api/tables/bases/${w.baseId}/members/${sales.id}`, 'DELETE'));
    expect(await (await send(owner, `/api/tables/roles/${w.role.id}`, 'DELETE')).json()).toMatchObject({
      details: { references: { users: 0, team: true } },
    });

    // A role of another Base is not accepted anywhere.
    const elsewhere = await json<{ base: { id: number } }>(
      await send(owner, '/api/tables/bases', 'POST', { name: 'Other' }),
      201,
    );
    const foreignRole = await json<{ role: { id: number } }>(
      await send(owner, `/api/tables/bases/${elsewhere.base.id}/roles`, 'POST', {
        name: 'Foreign',
        rules: { version: 1, dashboards: 'all', tables: [] },
      }),
      201,
    );
    expect(
      (
        await send(owner, `/api/tables/bases/${w.baseId}/members/${other.id}`, 'PUT', {
          role: 'custom',
          customRoleId: foreignRole.role.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send(owner, `/api/tables/bases/${w.baseId}`, 'PATCH', {
          teamRole: 'custom',
          teamCustomRoleId: foreignRole.role.id,
        })
      ).status,
    ).toBe(400);
    // Bad rules never get stored.
    expect(
      (
        await send(owner, `/api/tables/bases/${w.baseId}/roles`, 'POST', {
          name: 'Broken',
          rules: { version: 1, tables: [] },
        })
      ).status,
    ).toBe(400);
    expect((await send(owner, `/api/tables/roles/${w.role.id}`, 'PATCH', { revision: 99, name: 'x' })).status).toBe(
      409,
    );

    // Free the role from the team default, then it can go.
    await json(await send(owner, `/api/tables/bases/${w.baseId}`, 'PATCH', { teamRole: 'viewer' }));
    expect((await send(owner, `/api/tables/roles/${w.role.id}`, 'DELETE')).status).toBe(200);
  });

  it('resolves dangling or foreign custom grants to no access — never viewer (D13)', async () => {
    const w = await crm();
    await json(
      await send(owner, `/api/tables/bases/${w.baseId}`, 'PATCH', {
        visibility: 'team',
        teamRole: 'custom',
        teamCustomRoleId: w.role.id,
      }),
    );
    // The team default compiles: other (no member row) sees only its own customers — none.
    const asTeam = await json<{ access: TableBaseAccessView }>(await send(other, `/api/tables/bases/${w.baseId}`));
    expect(asTeam.access.level).toBe('custom');

    // Forge what the API refuses: a team default and a member row pointing at nothing.
    await db.tables.setBaseTeamRole(w.baseId, 'custom', null);
    expect((await send(other, `/api/tables/bases/${w.baseId}`)).status).toBe(404);
    const elsewhere = await db.tables.createBase({ name: 'Elsewhere', owner_id: owner.id, created_by: owner.id });
    const foreign = await db.tables.createBaseRole({
      base_id: elsewhere.id,
      name: 'Foreign',
      rules: { version: 1, dashboards: 'all', tables: [] },
      created_by: owner.id,
    });
    await db.tables.upsertBaseMember({
      base_id: w.baseId,
      user_id: sales.id,
      role: 'custom',
      custom_role_id: foreign.id,
      added_by: owner.id,
    });
    expect((await send(sales, `/api/tables/bases/${w.baseId}`)).status).toBe(404);
    await db.tables.upsertBaseMember({
      base_id: w.baseId,
      user_id: sales.id,
      role: 'custom',
      custom_role_id: null,
      added_by: owner.id,
    });
    expect((await send(sales, `/api/tables/bases/${w.baseId}`)).status).toBe(404);
    expect(await canRecipientRead({ db }, sales.id, { id: w.mine.id, table_id: w.customers })).toBeNull();
  });
});

describe('owner transfer', { timeout: 30_000 }, () => {
  it('hands the Base over and keeps the previous owner at the chosen role', async () => {
    const w = await crm();
    expect(
      (
        await send(sales, `/api/tables/bases/${w.baseId}/transfer`, 'POST', {
          userId: sales.id,
          previousOwnerRole: 'viewer',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await send(owner, `/api/tables/bases/${w.baseId}/transfer`, 'POST', {
          userId: other.id,
          previousOwnerRole: 'owner',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send(owner, `/api/tables/bases/${w.baseId}/transfer`, 'POST', {
          userId: owner.id,
          previousOwnerRole: 'viewer',
        })
      ).status,
    ).toBe(409);
    const moved = await json<{ base: { owner_id: string } }>(
      await send(owner, `/api/tables/bases/${w.baseId}/transfer`, 'POST', {
        userId: other.id,
        previousOwnerRole: 'editor',
      }),
    );
    expect(moved.base.owner_id).toBe(other.id);
    expect((await json<{ role: string }>(await send(owner, `/api/tables/bases/${w.baseId}`))).role).toBe('editor');
    expect((await json<{ role: string }>(await send(other, `/api/tables/bases/${w.baseId}`))).role).toBe('owner');
    expect((await send(owner, `/api/tables/bases/${w.baseId}/roles`)).status).toBe(404);
    expect((await send(other, `/api/tables/bases/${w.baseId}/roles`)).status).toBe(200);
  });
});
