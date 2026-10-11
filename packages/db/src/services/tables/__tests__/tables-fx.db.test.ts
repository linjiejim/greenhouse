/**
 * Slice Fx against real PostgreSQL, rolled back per test: formulas written as
 * text (parsed by `@greenhouse/types/table-formula`) are validated and
 * computed on write; lookup fields — validation, dependencies, computation in
 * link order, refresh when a target record or the target field changes, the
 * filter operators — and the narrowed rollup / lookup refresh.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetProvider,
  initDatabase,
  type CreateTableFieldInput,
  type DatabaseProvider,
  type TableFieldRow,
  type TableRecordRow,
  type UserRow,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { parseTableFormula, type TableFormulaField } from '@greenhouse/types/table-formula';
import { fullTableAccess } from '@greenhouse/types/table-access';
import type {
  TableFieldConfig,
  TableFilterGroup,
  TableFormulaResultType,
  TableRecordWriteMeta,
} from '@greenhouse/types/tables';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  owner = await createInternalTestUser(db, { email: `tables-fx-owner-${tag}@test.local`, nickname: 'Fx Owner' });
});

afterEach(() => {
  _resetProvider();
});

const full = () => fullTableAccess(owner.id);
const meta = (): TableRecordWriteMeta => ({ actorId: owner.id, actorKind: 'user', enqueueAutomations: false });

async function newTable(baseId: number, name: string) {
  const schema = await db.tables.createTable({ base_id: baseId, name, created_by: owner.id });
  const field = (
    fieldName: string,
    type: TableFieldRow['type'],
    extra: Partial<Pick<CreateTableFieldInput, 'config' | 'required'>> = {},
  ) => db.tables.createField({ table_id: schema.table.id, name: fieldName, type, created_by: owner.id, ...extra });
  const create = (values: Record<number, unknown>) =>
    db.tables.createRecord({ table_id: schema.table.id, values }, full(), meta());
  const update = (record: TableRecordRow, values: Record<number, unknown>) =>
    db.tables.updateRecord(
      { table_id: schema.table.id, record_id: record.id, revision: record.revision, values },
      full(),
      meta(),
    );
  const get = async (recordId: number) => (await db.tables.getRecord(schema.table.id, recordId, full()))!;
  return { tableId: schema.table.id, primary: schema.fields[0]!, field, create, update, get };
}

/** Parse formula text against the table's current fields, the way the editor does. */
async function formulaConfig(tableId: number, text: string, resultType: TableFormulaResultType) {
  const fields = await db.tables.listFields(tableId);
  const formulaFields: TableFormulaField[] = fields.map(({ id, name, type }) => ({ id, name, type }));
  const parsed = parseTableFormula(text, formulaFields);
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error.message}`);
  return { formula: { resultType, expression: parsed.expression } } satisfies TableFieldConfig;
}

async function crm() {
  const base = await db.tables.createBase({ name: 'CRM', owner_id: owner.id, created_by: owner.id });
  const customers = await newTable(base.id, 'Customers');
  const tier = await customers.field('Tier', 'single_select', {
    config: {
      options: [
        { id: 'gold', label: 'Gold' },
        { id: 'silver', label: 'Silver' },
      ],
    },
  });
  const tags = await customers.field('Tags', 'multi_select', {
    config: {
      options: [
        { id: 'vip', label: 'VIP' },
        { id: 'new', label: 'New' },
      ],
    },
  });
  const amount = await customers.field('Amount', 'number');
  const owners = await customers.field('Owner', 'user');
  const acme = await customers.create({
    [customers.primary.id]: 'Acme',
    [tier.id]: 'gold',
    [tags.id]: ['vip', 'new'],
    [amount.id]: 100,
  });
  const globex = await customers.create({ [customers.primary.id]: 'Globex', [tier.id]: 'silver', [amount.id]: 40 });
  const initech = await customers.create({ [customers.primary.id]: 'Initech', [amount.id]: 7 });

  const orders = await newTable(base.id, 'Orders');
  const customer = await orders.field('Customers', 'relation', {
    config: { relation: { targetTableId: customers.tableId, multiple: true } },
  });
  const names = await orders.field('Customer names', 'lookup', {
    config: { lookup: { relationFieldId: customer.id, targetFieldId: customers.primary.id } },
  });
  const tiers = await orders.field('Tiers', 'lookup', {
    config: { lookup: { relationFieldId: customer.id, targetFieldId: tier.id } },
  });
  const order = await orders.create({ [orders.primary.id]: 'O-1', [customer.id]: [globex.id, acme.id] });
  const lonely = await orders.create({ [orders.primary.id]: 'O-2' });
  return {
    base,
    customers,
    orders,
    fields: { tier, tags, amount, owners, customer, names, tiers },
    records: { acme, globex, initech, order, lonely },
  };
}

describe('Formula fields written as text', () => {
  it('validates and computes the acceptance formulas and the new functions on write', async () => {
    const base = await db.tables.createBase({ name: 'Deals', owner_id: owner.id, created_by: owner.id });
    const deals = await newTable(base.id, 'Deals');
    const qty = await deals.field('数量', 'number');
    const start = await deals.field('开始', 'date');
    const due = await deals.field('截止', 'date');
    const stage = await deals.field('Stage', 'single_select', {
      config: { options: [{ id: 'won-1', label: 'Won' }] },
    });
    const size = await deals.field('Size', 'formula', {
      config: await formulaConfig(deals.tableId, 'IF({数量} > 10, "大单", "小单")', 'text'),
    });
    const days = await deals.field('Days', 'formula', {
      config: await formulaConfig(deals.tableId, 'DATEDIFF({截止}, {开始}, "days")', 'number'),
    });
    const next = await deals.field('Next month', 'formula', {
      config: await formulaConfig(deals.tableId, 'DATEADD({开始}, 1, "months")', 'date'),
    });
    const label = await deals.field('Label', 'formula', {
      config: await formulaConfig(
        deals.tableId,
        'IF(AND({Stage} = "Won", NOT(CONTAINS({Name}, "test"))), UPPER(LEFT(TRIM({Name}), 3)) & "-" & YEAR({开始}), "")',
        'text',
      ),
    });
    const math = await deals.field('Math', 'formula', {
      config: await formulaConfig(
        deals.tableId,
        'MAX(ABS(-{数量}), MOD({数量}, 5), FLOOR(2.5), CEIL(LEN({Name})))',
        'number',
      ),
    });

    const deal = await deals.create({
      [deals.primary.id]: '  acme deal ',
      [qty.id]: 12,
      [start.id]: '2026-01-31',
      [due.id]: '2026-03-15',
      [stage.id]: 'won-1',
    });
    expect(deal.computed_values).toMatchObject({
      [String(size.id)]: '大单',
      [String(days.id)]: 43,
      [String(next.id)]: '2026-02-28',
      [String(label.id)]: 'ACM-2026',
      [String(math.id)]: 12,
    });
    const smaller = await deals.update(deal, { [qty.id]: 3, [deals.primary.id]: 'a test' });
    expect(smaller.ok && smaller.record.computed_values).toMatchObject({
      [String(size.id)]: '小单',
      [String(label.id)]: '',
      [String(math.id)]: 6,
    });
    expect((await db.tables.listFieldDependencies(days.id)).map((row) => row.depends_on_field_id).sort()).toEqual(
      [start.id, due.id].sort(),
    );
  });

  it('refuses the same references, arity and types the editor refuses', async () => {
    const base = await db.tables.createBase({ name: 'Checks', owner_id: owner.id, created_by: owner.id });
    const table = await newTable(base.id, 'Checks');
    const qty = await table.field('Qty', 'number');
    const doubled = await table.field('Doubled', 'formula', {
      config: await formulaConfig(table.tableId, '{Qty} * 2', 'number'),
    });
    const formula = (expression: unknown) =>
      table.field(`F${Math.random()}`, 'formula', {
        config: { formula: { resultType: 'number', expression } } as TableFieldConfig,
      });
    await expect(formula({ type: 'field', fieldId: doubled.id })).rejects.toThrow(/stored fields only/);
    await expect(formula({ type: 'field', fieldId: 999_999 })).rejects.toThrow(/Formula field 999999 is unavailable/);
    await expect(formula({ type: 'function', name: 'mod', args: [{ type: 'literal', value: 1 }] })).rejects.toThrow(
      /MOD takes 2 argument/,
    );
    await expect(
      formula({
        type: 'binary',
        operator: 'add',
        left: { type: 'field', fieldId: table.primary.id },
        right: { type: 'literal', value: 1 },
      }),
    ).rejects.toThrow(/use & to join text/);
    await expect(
      formula({
        type: 'function',
        name: 'datediff',
        args: [
          { type: 'field', fieldId: qty.id },
          { type: 'field', fieldId: qty.id },
        ],
      }),
    ).rejects.toThrow(/must be a date/);
    await expect(
      db.tables.updateField(doubled.id, {
        updated_by: owner.id,
        config: { formula: { resultType: 'number', expression: { type: 'field', fieldId: doubled.id } } },
      }),
    ).rejects.toThrow(/is unavailable/);
  });

  it('reads select labels and recomputes when an option is renamed', async () => {
    const base = await db.tables.createBase({ name: 'Labels', owner_id: owner.id, created_by: owner.id });
    const table = await newTable(base.id, 'Tasks');
    const status = await table.field('Status', 'single_select', {
      config: { options: [{ id: 'd', label: 'Done' }] },
    });
    const finished = await table.field('Finished', 'formula', {
      config: await formulaConfig(table.tableId, '{Status} = "Done"', 'boolean'),
    });
    const task = await table.create({ [table.primary.id]: 'T', [status.id]: 'd' });
    expect(task.computed_values[String(finished.id)]).toBe(true);
    await db.tables.updateField(status.id, {
      updated_by: owner.id,
      config: { options: [{ id: 'd', label: 'Shipped' }] },
    });
    expect((await table.get(task.id)).computed_values[String(finished.id)]).toBe(false);
  });
});

describe('Lookup fields', () => {
  it('validates the relation and target, records lookup dependencies', async () => {
    const { customers, orders, fields } = await crm();
    const lookup = (config: TableFieldConfig['lookup']) =>
      orders.field(`L${Math.random()}`, 'lookup', { config: { lookup: config } });
    await expect(orders.field('Bare', 'lookup', { config: {} })).rejects.toThrow(/relationFieldId and targetFieldId/);
    await expect(lookup({ relationFieldId: orders.primary.id, targetFieldId: customers.primary.id })).rejects.toThrow(
      /relation field on this table/,
    );
    await expect(lookup({ relationFieldId: fields.customer.id, targetFieldId: orders.primary.id })).rejects.toThrow(
      /target field is unavailable/,
    );
    await expect(lookup({ relationFieldId: fields.customer.id, targetFieldId: fields.owners.id })).rejects.toThrow(
      /not user/,
    );
    const totals = await orders.field('Total', 'rollup', {
      config: { rollup: { relationFieldId: fields.customer.id, targetFieldId: fields.amount.id, aggregation: 'sum' } },
    });
    // A lookup in Customers reading Orders' rollup would go stale: refused.
    const back = await customers.field('Orders', 'relation', {
      config: { relation: { targetTableId: orders.tableId, multiple: true } },
    });
    await expect(
      customers.field('Order totals', 'lookup', {
        config: { lookup: { relationFieldId: back.id, targetFieldId: totals.id } },
      }),
    ).rejects.toThrow(/not rollup/);
    expect(await db.tables.listFieldDependencies(fields.names.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ depends_on_field_id: fields.customer.id, dependency_type: 'lookup' }),
        expect.objectContaining({ depends_on_field_id: customers.primary.id, dependency_type: 'lookup' }),
      ]),
    );
  });

  it('computes the linked values in link order, with select labels and flattened lists', async () => {
    const { orders, fields, records } = await crm();
    const tags = await orders.field('Tags', 'lookup', {
      config: { lookup: { relationFieldId: fields.customer.id, targetFieldId: fields.tags.id } },
    });
    const order = await orders.get(records.order.id);
    expect(order.computed_values[String(fields.names.id)]).toEqual(['Globex', 'Acme']);
    expect(order.computed_values[String(fields.tiers.id)]).toEqual(['Silver', 'Gold']);
    expect(order.computed_values[String(tags.id)]).toEqual(['VIP', 'New']);
    expect(records.lonely.computed_values[String(fields.names.id)]).toEqual([]);

    // Re-pointing the relation recomputes in the same write.
    const repointed = await orders.update(order, { [fields.customer.id]: [records.initech.id] });
    expect(repointed.ok && repointed.record.computed_values).toMatchObject({
      [String(fields.names.id)]: ['Initech'],
      [String(fields.tiers.id)]: [],
    });
  });

  it('refreshes when a linked record changes, is deleted or restored', async () => {
    const { customers, orders, fields, records } = await crm();
    const renamed = await customers.update(records.acme, { [customers.primary.id]: 'Acme Corp' });
    expect(renamed.ok).toBe(true);
    expect((await orders.get(records.order.id)).computed_values[String(fields.names.id)]).toEqual([
      'Globex',
      'Acme Corp',
    ]);
    expect(await db.tables.listRecomputeJobs(records.order.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field_id: fields.names.id, status: 'succeeded' }),
        expect.objectContaining({ field_id: fields.tiers.id, status: 'succeeded' }),
      ]),
    );
    const globex = await customers.get(records.globex.id);
    const deleted = await db.tables.deleteRecord(
      { table_id: customers.tableId, record_id: globex.id, revision: globex.revision },
      full(),
      meta(),
    );
    expect(deleted.ok).toBe(true);
    expect((await orders.get(records.order.id)).computed_values[String(fields.names.id)]).toEqual(['Acme Corp']);
    await db.tables.restoreRecord({ table_id: customers.tableId, record_id: globex.id }, full(), meta());
    expect((await orders.get(records.order.id)).computed_values[String(fields.names.id)]).toEqual([
      'Globex',
      'Acme Corp',
    ]);
  });

  it('refreshes when the target field changes: a formula redefined, options renamed, the field archived', async () => {
    const { customers, orders, fields, records } = await crm();
    const label = await customers.field('Label', 'formula', {
      config: await formulaConfig(customers.tableId, '{Name} & "!"', 'text'),
    });
    const labels = await orders.field('Labels', 'lookup', {
      config: { lookup: { relationFieldId: fields.customer.id, targetFieldId: label.id } },
    });
    expect((await orders.get(records.order.id)).computed_values[String(labels.id)]).toEqual(['Globex!', 'Acme!']);

    await db.tables.updateField(label.id, {
      updated_by: owner.id,
      config: await formulaConfig(customers.tableId, 'LOWER({Name})', 'text'),
    });
    expect((await orders.get(records.order.id)).computed_values[String(labels.id)]).toEqual(['globex', 'acme']);

    await db.tables.updateField(fields.tier.id, {
      updated_by: owner.id,
      config: {
        options: [
          { id: 'gold', label: 'Platinum' },
          { id: 'silver', label: 'Silver' },
        ],
      },
    });
    expect((await orders.get(records.order.id)).computed_values[String(fields.tiers.id)]).toEqual([
      'Silver',
      'Platinum',
    ]);

    await db.tables.archiveField(fields.tier.id, owner.id);
    expect((await orders.get(records.order.id)).computed_values[String(fields.tiers.id)]).toEqual([]);
  });

  it('filters with contains / is_empty / is_not_empty and refuses other operators', async () => {
    const { customers, orders, fields, records } = await crm();
    const third = await orders.create({ [orders.primary.id]: 'O-3', [fields.customer.id]: [records.initech.id] });
    const match = async (where: TableFilterGroup) =>
      (await db.tables.queryRecords(orders.tableId, { where, limit: 50 }, full())).records
        .map((record) => record.id)
        .sort((a, b) => a - b);
    const clause = (operator: 'contains' | 'is_empty' | 'is_not_empty' | 'eq', value?: unknown) => ({
      combinator: 'and' as const,
      clauses: [{ fieldId: fields.names.id, operator, value }],
    });
    expect(await match(clause('contains', 'acm'))).toEqual([records.order.id]);
    expect(await match(clause('contains', 'INITECH'))).toEqual([third.id]);
    expect(await match(clause('contains', '50%'))).toEqual([]);
    expect(await match(clause('is_empty'))).toEqual([records.lonely.id]);
    expect(await match(clause('is_not_empty'))).toEqual([records.order.id, third.id].sort((a, b) => a - b));
    expect(
      await match({ combinator: 'and', clauses: [{ fieldId: fields.tiers.id, operator: 'contains', value: 'gold' }] }),
    ).toEqual([records.order.id]);
    await expect(match(clause('eq', 'Acme'))).rejects.toThrow(/Operator eq is not supported for lookup/);
    await expect(match(clause('contains', ''))).rejects.toThrow(/contains expects text/);
    // Search covers the lookup's values like any text column.
    const searched = await db.tables.queryRecords(orders.tableId, { search: 'globex', limit: 50 }, full());
    expect(searched.records.map((record) => record.id)).toEqual([records.order.id]);
    // Empty lists count as empty for every list field (a multi-select cleared to []).
    const cleared = await customers.update(records.acme, { [fields.tags.id]: [] });
    expect(cleared.ok).toBe(true);
    const emptyTags = (
      await db.tables.queryRecords(
        customers.tableId,
        { where: { combinator: 'and', clauses: [{ fieldId: fields.tags.id, operator: 'is_empty' }] }, limit: 50 },
        full(),
      )
    ).records.map((record) => record.id);
    expect(emptyTags.sort((a, b) => a - b)).toEqual(
      [records.acme.id, records.globex.id, records.initech.id].sort((a, b) => a - b),
    );
  });
});

describe('Narrowed refresh', () => {
  it('only touches tables whose rollups / lookups read the changed table', async () => {
    const { customers, orders, fields, records } = await crm();
    // Another Base with its own rollup.
    const base = await db.tables.createBase({ name: 'Elsewhere', owner_id: owner.id, created_by: owner.id });
    const tasks = await newTable(base.id, 'Tasks');
    const effort = await tasks.field('Effort', 'number');
    const boards = await newTable(base.id, 'Boards');
    const boardTasks = await boards.field('Tasks', 'relation', {
      config: { relation: { targetTableId: tasks.tableId, multiple: true } },
    });
    await boards.field('Effort', 'rollup', {
      config: { rollup: { relationFieldId: boardTasks.id, targetFieldId: effort.id, aggregation: 'sum' } },
    });
    const task = await tasks.create({ [tasks.primary.id]: 'T', [effort.id]: 2 });
    const board = await boards.create({ [boards.primary.id]: 'B', [boardTasks.id]: [task.id] });

    // A customer change refreshes the order that links it, and nothing in the other Base.
    await customers.update(records.initech, { [customers.primary.id]: 'Initech 2' });
    expect(await db.tables.listRecomputeJobs(records.order.id)).toEqual([]);
    expect(await db.tables.listRecomputeJobs(board.id)).toEqual([]);
    const changed = await tasks.update(task, { [effort.id]: 5 });
    expect(changed.ok).toBe(true);
    expect(await db.tables.listRecomputeJobs(board.id)).toEqual([expect.objectContaining({ status: 'succeeded' })]);
    expect(await db.tables.listRecomputeJobs(records.order.id)).toEqual([]);
    expect(fields.names.table_id).toBe(orders.tableId);
  });
});
