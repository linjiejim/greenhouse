import { parseTableFieldConfig, validateTableFieldConfig } from '../db-service.js';
import { TablesValidationError } from '../db-service.js';
import { services } from '../services.js';
/**
 * Tables domain service integration tests (real PostgreSQL).
 *
 * Requires PostgreSQL at TEST_DATABASE_URL. The DB project supplies a clean
 * transaction for every test and rolls it back afterward.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let ownerId: string;
let teammateId: string;

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const [owner, teammate] = await Promise.all([
    createInternalTestUser(db, { email: 'tables-owner@test.com', nickname: 'Tables Owner' }),
    createInternalTestUser(db, { email: 'tables-teammate@test.com', nickname: 'Tables Teammate' }),
  ]);
  ownerId = owner.id;
  teammateId = teammate.id;
});

afterEach(async () => {
  await db.close();
  _resetProvider();
});

async function fixture() {
  const base = await services(db).tables.createBase({
    name: 'Launch operations',
    visibility: 'private',
    owner_id: ownerId,
    created_by: ownerId,
  });
  const schema = await services(db).tables.createTable({
    base_id: base.id,
    name: 'Work items',
    created_by: ownerId,
  });
  return { base, schema, primary: schema.fields[0]! };
}

async function createStatusField(tableId: string) {
  return services(db).tables.createField({
    table_id: tableId,
    name: 'Status',
    type: 'single_select',
    config: {
      options: [
        { id: 'todo', label: 'To do' },
        { id: 'done', label: 'Done' },
      ],
    },
    created_by: ownerId,
  });
}

async function createScoreField(tableId: string) {
  return services(db).tables.createField({
    table_id: tableId,
    name: 'Score',
    type: 'number',
    created_by: ownerId,
  });
}

async function createAssigneeField(tableId: string) {
  return services(db).tables.createField({
    table_id: tableId,
    name: 'Assignee',
    type: 'user',
    created_by: ownerId,
  });
}

describe('Tables domain service', () => {
  it('versions table schema snapshots and protects mutable configurations with revisions', async () => {
    const base = await services(db).tables.createBase({
      name: 'Versioned Base',
      owner_id: ownerId,
      created_by: ownerId,
    });
    const schema = await services(db).tables.createTable({
      base_id: base.id,
      name: 'Versioned Table',
      created_by: ownerId,
    });
    expect(schema.table.schema_revision).toBe(1);
    expect(await services(db).tables.listSchemaVersions(schema.table.id)).toEqual([
      expect.objectContaining({ version: 1, change_type: 'created', changed_by: ownerId }),
    ]);

    const field = await services(db).tables.createField({
      table_id: schema.table.id,
      name: 'Stage',
      type: 'text',
      created_by: ownerId,
    });
    await services(db).tables.updateField(field.id, {
      updated_by: teammateId,
      name: 'Phase',
    });
    await services(db).tables.archiveField(field.id, ownerId);
    const versions = await services(db).tables.listSchemaVersions(schema.table.id);
    expect(versions.map((version) => version.version)).toEqual([4, 3, 2, 1]);
    expect(versions.map((version) => version.change_type)).toEqual([
      'field_archived',
      'field_updated',
      'field_created',
      'created',
    ]);
    expect(versions[0]!.schema_snapshot.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: field.id, name: 'Phase', archivedAt: expect.any(String) }),
      ]),
    );
    expect((await services(db).tables.getTable(schema.table.id))?.schema_revision).toBe(4);

    const view = schema.views[0]!;
    const viewUpdated = await services(db).tables.updateView(view.id, {
      revision: view.revision,
      name: 'Main grid',
    });
    expect(viewUpdated).toMatchObject({ ok: true, value: { revision: 2, name: 'Main grid' } });
    expect(await services(db).tables.updateView(view.id, { revision: view.revision, name: 'Stale' })).toEqual({
      ok: false,
      reason: 'conflict',
      current: 2,
    });
  });

  it('supports same-Base relations, safe formulas, and refreshed rollups', async () => {
    const base = await services(db).tables.createBase({
      name: 'Modeling Base',
      owner_id: ownerId,
      created_by: ownerId,
    });
    const projects = await services(db).tables.createTable({
      base_id: base.id,
      name: 'Projects',
      created_by: ownerId,
    });
    const tasks = await services(db).tables.createTable({
      base_id: base.id,
      name: 'Tasks',
      created_by: ownerId,
    });
    const effort = await services(db).tables.createField({
      table_id: tasks.table.id,
      name: 'Effort',
      type: 'number',
      created_by: ownerId,
    });
    const doubled = await services(db).tables.createField({
      table_id: tasks.table.id,
      name: 'Double effort',
      type: 'formula',
      config: {
        formula: {
          resultType: 'number',
          expression: {
            type: 'binary',
            operator: 'multiply',
            left: { type: 'field', fieldId: effort.id },
            right: { type: 'field', fieldId: effort.id },
          },
        },
      },
      created_by: ownerId,
    });
    const taskA = await services(db).tables.createRecord({
      table_id: tasks.table.id,
      values: { [tasks.fields[0]!.id]: 'Task A', [effort.id]: 3 },
      user_id: ownerId,
    });
    const taskB = await services(db).tables.createRecord({
      table_id: tasks.table.id,
      values: { [tasks.fields[0]!.id]: 'Task B', [effort.id]: 5 },
      user_id: ownerId,
    });
    expect(taskA.computed_values[String(doubled.id)]).toBe(9);

    const linkedTasks = await services(db).tables.createField({
      table_id: projects.table.id,
      name: 'Tasks',
      type: 'relation',
      config: { relation: { targetTableId: tasks.table.id, multiple: true } },
      created_by: ownerId,
    });
    const totalEffort = await services(db).tables.createField({
      table_id: projects.table.id,
      name: 'Total effort',
      type: 'rollup',
      config: {
        rollup: {
          relationFieldId: linkedTasks.id,
          targetFieldId: effort.id,
          aggregation: 'sum',
        },
      },
      created_by: ownerId,
    });
    const project = await services(db).tables.createRecord({
      table_id: projects.table.id,
      values: {
        [projects.fields[0]!.id]: 'Launch',
        [linkedTasks.id]: [taskA.id, taskB.id],
      },
      user_id: ownerId,
    });
    expect(project.computed_values[String(totalEffort.id)]).toBe(8);
    expect(await services(db).tables.listRecordLinks(linkedTasks.id, project.id)).toEqual([
      expect.objectContaining({ field_id: linkedTasks.id, target_record_id: taskA.id, position: 0 }),
      expect.objectContaining({ field_id: linkedTasks.id, target_record_id: taskB.id, position: 1 }),
    ]);
    expect(await services(db).tables.listFieldDependencies(totalEffort.id)).toHaveLength(2);

    await services(db).tables.updateRecord({
      table_id: tasks.table.id,
      record_id: taskA.id,
      revision: taskA.revision,
      values: { [effort.id]: 7 },
      user_id: ownerId,
    });
    expect(
      (await services(db).tables.getRecord(projects.table.id, project.id))?.computed_values[String(totalEffort.id)],
    ).toBe(12);
    expect(await services(db).tables.listRecomputeJobs(project.id)).toEqual([
      expect.objectContaining({ field_id: totalEffort.id, status: 'succeeded' }),
    ]);

    const otherBase = await services(db).tables.createBase({
      name: 'Other Base',
      owner_id: ownerId,
      created_by: ownerId,
    });
    const externalTable = await services(db).tables.createTable({
      base_id: otherBase.id,
      name: 'External',
      created_by: ownerId,
    });
    await expect(
      services(db).tables.createField({
        table_id: projects.table.id,
        name: 'Invalid relation',
        type: 'relation',
        config: { relation: { targetTableId: externalTable.table.id } },
        created_by: ownerId,
      }),
    ).rejects.toThrow(/same Base/);
  });

  it('validates dynamic fields and supports bounded query, cursor, and aggregate paths', async () => {
    const { schema, primary } = await fixture();
    const status = await createStatusField(schema.table.id);
    const score = await createScoreField(schema.table.id);
    const assignee = await createAssigneeField(schema.table.id);
    const first = await services(db).tables.createRecord({
      table_id: schema.table.id,
      values: {
        [primary.id]: 'Prepare launch',
        [status.id]: 'todo',
        [score.id]: 8,
        [assignee.id]: teammateId,
      },
      user_id: ownerId,
    });
    await services(db).tables.createRecord({
      table_id: schema.table.id,
      values: {
        [primary.id]: 'Publish notes',
        [status.id]: 'done',
        [score.id]: 3,
        [assignee.id]: ownerId,
      },
      user_id: ownerId,
    });

    const filtered = await services(db).tables.queryRecords(schema.table.id, {
      where: { combinator: 'and', clauses: [{ fieldId: score.id, operator: 'gt', value: 5 }] },
      sort: [{ fieldId: score.id, direction: 'desc' }],
      limit: 1,
    });
    expect(filtered.records.map((record) => record.id)).toEqual([first.id]);
    expect(filtered.total).toBe(1);

    const firstPage = await services(db).tables.queryRecords(schema.table.id, {
      sort: [{ fieldId: score.id, direction: 'desc' }],
      limit: 1,
    });
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPage = await services(db).tables.queryRecords(schema.table.id, {
      sort: [{ fieldId: score.id, direction: 'desc' }],
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.records).toHaveLength(1);
    expect(secondPage.records[0]!.id).not.toBe(firstPage.records[0]!.id);

    const grouped = await services(db).tables.aggregateRecords(schema.table.id, {
      operation: 'count',
      groupByFieldId: status.id,
    });
    expect(grouped).toEqual(
      expect.arrayContaining([
        { group: 'todo', value: 1 },
        { group: 'done', value: 1 },
      ]),
    );
    const sum = await services(db).tables.aggregateRecords(schema.table.id, {
      operation: 'sum',
      valueFieldId: score.id,
    });
    expect(sum).toEqual([{ group: null, value: 11 }]);
  });

  it('reads many records by id in one query, only from its own table and never deleted ones', async () => {
    const { schema, primary } = await fixture();
    const other = await services(db).tables.createTable({
      base_id: schema.table.base_id,
      name: 'Other',
      created_by: ownerId,
    });
    const make = (tableId: string, primaryId: string, name: string) =>
      services(db).tables.createRecord({ table_id: tableId, values: { [primaryId]: name }, user_id: ownerId });
    const a = await make(schema.table.id, primary.id, 'A');
    const b = await make(schema.table.id, primary.id, 'B');
    const gone = await make(schema.table.id, primary.id, 'Gone');
    await make(schema.table.id, primary.id, 'Not asked');
    const foreign = await make(other.table.id, other.fields[0]!.id, 'Foreign');
    await services(db).tables.deleteRecord({
      table_id: schema.table.id,
      record_id: gone.id,
      revision: gone.revision,
      user_id: ownerId,
    });

    const page = await services(db).tables.queryRecords(schema.table.id, {
      recordIds: [a.id, b.id, gone.id, foreign.id, 'rec_missing'],
      limit: 5,
    });
    expect(page.records.map((record) => record.id).sort()).toEqual([a.id, b.id].sort());
    expect(page.total).toBe(2);
    expect((await services(db).tables.queryRecords(schema.table.id, { recordIds: [] })).records).toEqual([]);
    await expect(
      services(db).tables.queryRecords(schema.table.id, { recordIds: 'nope' as unknown as string[] }),
    ).rejects.toBeInstanceOf(TablesValidationError);
    await expect(
      services(db).tables.queryRecords(schema.table.id, {
        recordIds: Array.from({ length: 501 }, (_, index) => `rec_${index}`),
      }),
    ).rejects.toBeInstanceOf(TablesValidationError);
  });

  it('enforces optimistic revision and rejects invalid field/user/select values', async () => {
    const { schema, primary } = await fixture();
    const status = await createStatusField(schema.table.id);
    const assignee = await createAssigneeField(schema.table.id);
    const record = await services(db).tables.createRecord({
      table_id: schema.table.id,
      values: { [primary.id]: 'Original', [status.id]: 'todo', [assignee.id]: teammateId },
      user_id: ownerId,
    });
    const updated = await services(db).tables.updateRecord({
      table_id: schema.table.id,
      record_id: record.id,
      revision: record.revision,
      values: { [primary.id]: 'Updated' },
      user_id: teammateId,
    });
    expect(updated).toMatchObject({ ok: true, record: { revision: 2 } });

    const conflict = await services(db).tables.updateRecord({
      table_id: schema.table.id,
      record_id: record.id,
      revision: record.revision,
      values: { [primary.id]: 'Stale overwrite' },
      user_id: ownerId,
    });
    expect(conflict).toEqual({ ok: false, reason: 'conflict', current: 2 });

    const validation = await services(db).tables.validateBatchRecords({
      table_id: schema.table.id,
      items: [
        { record_id: record.id, revision: 2, values: { [primary.id]: 'Valid batch update' } },
        { record_id: record.id, revision: 1, values: { [primary.id]: 'Stale batch update' } },
        { values: { [primary.id]: 'Bad batch option', [status.id]: 'missing' } },
      ],
    });
    expect(validation).toEqual([
      { index: 0, ok: true },
      { index: 1, ok: false, reason: 'conflict', current: 2 },
      expect.objectContaining({ index: 2, ok: false, reason: 'invalid' }),
    ]);

    await expect(
      services(db).tables.createRecord({
        table_id: schema.table.id,
        values: { [primary.id]: 'Bad option', [status.id]: 'missing' },
        user_id: ownerId,
      }),
    ).rejects.toThrow(/expects a configured option id/);
    await expect(
      services(db).tables.createRecord({
        table_id: schema.table.id,
        values: { [primary.id]: 'Bad user', [assignee.id]: 'disabled-or-unknown' },
        user_id: ownerId,
      }),
    ).rejects.toThrow(/active internal user/);
    await expect(
      services(db).tables.queryRecords(schema.table.id, {
        where: { combinator: 'and', clauses: null as never },
      }),
    ).rejects.toBeInstanceOf(TablesValidationError);
  });

  it('persists members and personal/shared views', async () => {
    const { base, schema, primary } = await fixture();
    const status = await createStatusField(schema.table.id);
    const member = await services(db).tables.upsertBaseMember({
      base_id: base.id,
      user_id: teammateId,
      role: 'editor',
      added_by: ownerId,
    });
    expect(member.role).toBe('editor');

    const personal = await services(db).tables.createView({
      table_id: schema.table.id,
      name: 'My open work',
      scope: 'personal',
      owner_id: teammateId,
      config: {
        fieldIds: [primary.id, status.id],
        query: { where: { combinator: 'and', clauses: [{ fieldId: status.id, operator: 'eq', value: 'todo' }] } },
      },
      created_by: teammateId,
    });
    expect((await services(db).tables.listViews(schema.table.id, teammateId)).map((view) => view.id)).toContain(
      personal.id,
    );
    expect((await services(db).tables.listViews(schema.table.id, ownerId)).map((view) => view.id)).not.toContain(
      personal.id,
    );
  });

  it('keeps Base members as shares rows', async () => {
    const { base } = await fixture();
    expect(base.id).toMatch(/^bas_/);
    expect(await services(db).tables.listBaseMembers(base.id)).toEqual([
      expect.objectContaining({ base_id: base.id, user_id: ownerId, role: 'owner', added_by: ownerId }),
    ]);
    expect((await services(db).tables.listBasesForUser(teammateId)).map((row) => row.id)).not.toContain(base.id);

    await services(db).tables.upsertBaseMember({
      base_id: base.id,
      user_id: teammateId,
      role: 'viewer',
      added_by: ownerId,
    });
    const promoted = await services(db).tables.upsertBaseMember({
      base_id: base.id,
      user_id: teammateId,
      role: 'builder',
      added_by: ownerId,
    });
    expect(promoted).toMatchObject({ base_id: base.id, user_id: teammateId, role: 'builder' });
    expect(await services(db).tables.listBaseMembers(base.id)).toHaveLength(2);
    expect(await services(db).tables.getBaseMember(base.id, teammateId)).toMatchObject({ role: 'builder' });
    expect((await services(db).tables.listBasesForUser(teammateId)).map((row) => row.id)).toContain(base.id);

    expect(await services(db).tables.removeBaseMember(base.id, teammateId)).toBe(true);
    expect(await services(db).tables.getBaseMember(base.id, teammateId)).toBeUndefined();
    expect(await services(db).tables.removeBaseMember(base.id, teammateId)).toBe(false);
  });

  it('stores relation values as record id strings and normalizes legacy numeric ids', async () => {
    const base = await services(db).tables.createBase({ name: 'Legacy ids', owner_id: ownerId, created_by: ownerId });
    const people = await services(db).tables.createTable({ base_id: base.id, name: 'People', created_by: ownerId });
    const teams = await services(db).tables.createTable({ base_id: base.id, name: 'Teams', created_by: ownerId });
    const lead = await services(db).tables.createField({
      table_id: teams.table.id,
      name: 'Lead',
      type: 'relation',
      config: { relation: { targetTableId: people.table.id } },
      created_by: ownerId,
    });
    const person = await services(db).tables.createRecord({
      table_id: people.table.id,
      values: { [people.fields[0]!.id]: 'Ada' },
      user_id: ownerId,
    });
    const team = await services(db).tables.createRecord({
      table_id: teams.table.id,
      values: { [teams.fields[0]!.id]: 'Core', [lead.id]: person.id },
      user_id: ownerId,
    });
    expect(team.values[lead.id]).toBe(person.id);
    expect(await services(db).tables.listRecordLinks(lead.id, team.id)).toEqual([
      expect.objectContaining({ target_record_id: person.id, position: 0 }),
    ]);
    // Rows carried from 1.x keep "42"-style ids; a client may still send them as numbers.
    expect(validateTableFieldConfig('relation', { relation: { targetTableId: 42 as never } })).toEqual({
      version: 1,
      relation: { targetTableId: '42', multiple: false },
    });
    expect(parseTableFieldConfig({ config: { rollup: { relationFieldId: 7, targetFieldId: 8 } } as never })).toEqual({
      rollup: { relationFieldId: '7', targetFieldId: '8' },
    });
  });

  it('accepts only active Drive files from the same Base and persists attachment edges', async () => {
    const { base, schema, primary } = await fixture();
    const attachments = await services(db).tables.createField({
      table_id: schema.table.id,
      name: 'Files',
      type: 'attachment',
      created_by: ownerId,
    });
    const pending = await db.drive.initFile({
      scope: 'tables',
      base_id: base.id,
      name: 'launch.pdf',
      cos_key: 'drive/tables/test/launch.pdf',
      uploaded_by: ownerId,
    });
    await db.drive.completeFile(pending.id, { size: 100 });
    const record = await services(db).tables.createRecord({
      table_id: schema.table.id,
      values: { [primary.id]: 'Launch package', [attachments.id]: [pending.id] },
      user_id: ownerId,
    });
    expect(await services(db).tables.listRecordAttachments(record.id, attachments.id)).toEqual([
      expect.objectContaining({
        record_id: record.id,
        field_id: attachments.id,
        drive_file_id: pending.id,
        position: 0,
      }),
    ]);

    const otherBase = await services(db).tables.createBase({
      name: 'Other attachment Base',
      owner_id: ownerId,
      created_by: ownerId,
    });
    const foreign = await db.drive.initFile({
      scope: 'tables',
      base_id: otherBase.id,
      name: 'foreign.pdf',
      cos_key: 'drive/tables/test/foreign.pdf',
      uploaded_by: ownerId,
    });
    await db.drive.completeFile(foreign.id, { size: 100 });
    await expect(
      services(db).tables.createRecord({
        table_id: schema.table.id,
        values: { [primary.id]: 'Blocked package', [attachments.id]: [foreign.id] },
        user_id: ownerId,
      }),
    ).rejects.toThrow(/unavailable Base file/);

    await expect(
      services(db).tables.createRecord({
        table_id: schema.table.id,
        values: {
          [primary.id]: 'Legacy string handle',
          [attachments.id]: ['1750000000000-deadbeef.pdf'],
        },
        user_id: ownerId,
      }),
    ).rejects.toThrow(/unavailable Base file/);
    await expect(
      services(db).tables.createRecord({
        table_id: schema.table.id,
        values: { [primary.id]: 'Not an id', [attachments.id]: [{ id: pending.id }] },
        user_id: ownerId,
      }),
    ).rejects.toThrow(/expects Drive file ids/);
  });
});
