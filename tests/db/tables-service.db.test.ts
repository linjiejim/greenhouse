/**
 * Tables domain service integration tests (real PostgreSQL).
 *
 * Requires PostgreSQL at TEST_DATABASE_URL. The DB project supplies a clean
 * transaction for every test and rolls it back afterward.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, TablesValidationError, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';

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
  const base = await db.tables.createBase({
    name: 'Launch operations',
    visibility: 'private',
    owner_id: ownerId,
    created_by: ownerId,
  });
  const schema = await db.tables.createTable({
    base_id: base.id,
    name: 'Work items',
    created_by: ownerId,
  });
  return { base, schema, primary: schema.fields[0]! };
}

async function createStatusField(tableId: number) {
  return db.tables.createField({
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

async function createScoreField(tableId: number) {
  return db.tables.createField({
    table_id: tableId,
    name: 'Score',
    type: 'number',
    created_by: ownerId,
  });
}

async function createAssigneeField(tableId: number) {
  return db.tables.createField({
    table_id: tableId,
    name: 'Assignee',
    type: 'user',
    created_by: ownerId,
  });
}

describe('Tables domain service', () => {
  it('versions table schema snapshots and protects mutable configurations with revisions', async () => {
    const base = await db.tables.createBase({
      name: 'Versioned Base',
      owner_id: ownerId,
      created_by: ownerId,
    });
    const schema = await db.tables.createTable({
      base_id: base.id,
      name: 'Versioned Table',
      created_by: ownerId,
    });
    expect(schema.table.schema_revision).toBe(1);
    expect(await db.tables.listSchemaVersions(schema.table.id)).toEqual([
      expect.objectContaining({ version: 1, change_type: 'created', changed_by: ownerId }),
    ]);

    const field = await db.tables.createField({
      table_id: schema.table.id,
      name: 'Stage',
      type: 'text',
      created_by: ownerId,
    });
    await db.tables.updateField(field.id, {
      updated_by: teammateId,
      name: 'Phase',
    });
    await db.tables.archiveField(field.id, ownerId);
    const versions = await db.tables.listSchemaVersions(schema.table.id);
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
    expect((await db.tables.getTable(schema.table.id))?.schema_revision).toBe(4);

    const view = schema.views[0]!;
    const viewUpdated = await db.tables.updateView(view.id, {
      revision: view.revision,
      name: 'Main grid',
    });
    expect(viewUpdated).toMatchObject({ ok: true, value: { revision: 2, name: 'Main grid' } });
    expect(await db.tables.updateView(view.id, { revision: view.revision, name: 'Stale' })).toEqual({
      ok: false,
      reason: 'conflict',
      current: 2,
    });

    const dashboard = await db.tables.createDashboard({
      base_id: base.id,
      name: 'Version dashboard',
      created_by: ownerId,
    });
    const dashboardUpdated = await db.tables.updateDashboard(dashboard.id, {
      revision: dashboard.revision,
      name: 'Version dashboard 2',
    });
    expect(dashboardUpdated).toMatchObject({ ok: true, value: { revision: 2 } });
    const widget = await db.tables.createDashboardWidget({
      dashboard_id: dashboard.id,
      table_id: schema.table.id,
      type: 'kpi',
      title: 'Count',
      created_by: ownerId,
    });
    const widgetUpdated = await db.tables.updateDashboardWidget(widget.id, {
      revision: widget.revision,
      title: 'Total',
    });
    expect(widgetUpdated).toMatchObject({ ok: true, value: { revision: 2, title: 'Total' } });
  });

  it('supports same-Base relations, safe formulas, and refreshed rollups', async () => {
    const base = await db.tables.createBase({
      name: 'Modeling Base',
      owner_id: ownerId,
      created_by: ownerId,
    });
    const projects = await db.tables.createTable({
      base_id: base.id,
      name: 'Projects',
      created_by: ownerId,
    });
    const tasks = await db.tables.createTable({
      base_id: base.id,
      name: 'Tasks',
      created_by: ownerId,
    });
    const effort = await db.tables.createField({
      table_id: tasks.table.id,
      name: 'Effort',
      type: 'number',
      created_by: ownerId,
    });
    const doubled = await db.tables.createField({
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
    const taskA = await db.tables.createRecord({
      table_id: tasks.table.id,
      values: { [tasks.fields[0]!.id]: 'Task A', [effort.id]: 3 },
      user_id: ownerId,
    });
    const taskB = await db.tables.createRecord({
      table_id: tasks.table.id,
      values: { [tasks.fields[0]!.id]: 'Task B', [effort.id]: 5 },
      user_id: ownerId,
    });
    expect(taskA.computed_values[String(doubled.id)]).toBe(9);

    const linkedTasks = await db.tables.createField({
      table_id: projects.table.id,
      name: 'Tasks',
      type: 'relation',
      config: { relation: { targetTableId: tasks.table.id, multiple: true } },
      created_by: ownerId,
    });
    const totalEffort = await db.tables.createField({
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
    const project = await db.tables.createRecord({
      table_id: projects.table.id,
      values: {
        [projects.fields[0]!.id]: 'Launch',
        [linkedTasks.id]: [taskA.id, taskB.id],
      },
      user_id: ownerId,
    });
    expect(project.computed_values[String(totalEffort.id)]).toBe(8);
    expect(await db.tables.listRecordLinks(linkedTasks.id, project.id)).toEqual([
      expect.objectContaining({ field_id: linkedTasks.id, target_record_id: taskA.id, position: 0 }),
      expect.objectContaining({ field_id: linkedTasks.id, target_record_id: taskB.id, position: 1 }),
    ]);
    expect(await db.tables.listFieldDependencies(totalEffort.id)).toHaveLength(2);

    await db.tables.updateRecord({
      table_id: tasks.table.id,
      record_id: taskA.id,
      revision: taskA.revision,
      values: { [effort.id]: 7 },
      user_id: ownerId,
    });
    expect((await db.tables.getRecord(projects.table.id, project.id))?.computed_values[String(totalEffort.id)]).toBe(
      12,
    );
    expect(await db.tables.listRecomputeJobs(project.id)).toEqual([
      expect.objectContaining({ field_id: totalEffort.id, status: 'succeeded' }),
    ]);

    const otherBase = await db.tables.createBase({
      name: 'Other Base',
      owner_id: ownerId,
      created_by: ownerId,
    });
    const externalTable = await db.tables.createTable({
      base_id: otherBase.id,
      name: 'External',
      created_by: ownerId,
    });
    await expect(
      db.tables.createField({
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
    const first = await db.tables.createRecord({
      table_id: schema.table.id,
      values: {
        [primary.id]: 'Prepare launch',
        [status.id]: 'todo',
        [score.id]: 8,
        [assignee.id]: teammateId,
      },
      user_id: ownerId,
    });
    await db.tables.createRecord({
      table_id: schema.table.id,
      values: {
        [primary.id]: 'Publish notes',
        [status.id]: 'done',
        [score.id]: 3,
        [assignee.id]: ownerId,
      },
      user_id: ownerId,
    });

    const filtered = await db.tables.queryRecords(schema.table.id, {
      where: { combinator: 'and', clauses: [{ fieldId: score.id, operator: 'gt', value: 5 }] },
      sort: [{ fieldId: score.id, direction: 'desc' }],
      limit: 1,
    });
    expect(filtered.records.map((record) => record.id)).toEqual([first.id]);
    expect(filtered.total).toBe(1);

    const firstPage = await db.tables.queryRecords(schema.table.id, {
      sort: [{ fieldId: score.id, direction: 'desc' }],
      limit: 1,
    });
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPage = await db.tables.queryRecords(schema.table.id, {
      sort: [{ fieldId: score.id, direction: 'desc' }],
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.records).toHaveLength(1);
    expect(secondPage.records[0]!.id).not.toBe(firstPage.records[0]!.id);

    const grouped = await db.tables.aggregateRecords(schema.table.id, {
      operation: 'count',
      groupByFieldId: status.id,
    });
    expect(grouped).toEqual(
      expect.arrayContaining([
        { group: 'todo', value: 1 },
        { group: 'done', value: 1 },
      ]),
    );
    const sum = await db.tables.aggregateRecords(schema.table.id, {
      operation: 'sum',
      valueFieldId: score.id,
    });
    expect(sum).toEqual([{ group: null, value: 11 }]);
  });

  it('enforces optimistic revision and rejects invalid field/user/select values', async () => {
    const { schema, primary } = await fixture();
    const status = await createStatusField(schema.table.id);
    const assignee = await createAssigneeField(schema.table.id);
    const record = await db.tables.createRecord({
      table_id: schema.table.id,
      values: { [primary.id]: 'Original', [status.id]: 'todo', [assignee.id]: teammateId },
      user_id: ownerId,
    });
    const updated = await db.tables.updateRecord({
      table_id: schema.table.id,
      record_id: record.id,
      revision: record.revision,
      values: { [primary.id]: 'Updated' },
      user_id: teammateId,
    });
    expect(updated).toMatchObject({ ok: true, record: { revision: 2 } });

    const conflict = await db.tables.updateRecord({
      table_id: schema.table.id,
      record_id: record.id,
      revision: record.revision,
      values: { [primary.id]: 'Stale overwrite' },
      user_id: ownerId,
    });
    expect(conflict).toEqual({ ok: false, reason: 'conflict', current: 2 });

    const validation = await db.tables.validateBatchRecords({
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
      db.tables.createRecord({
        table_id: schema.table.id,
        values: { [primary.id]: 'Bad option', [status.id]: 'missing' },
        user_id: ownerId,
      }),
    ).rejects.toThrow(/expects a configured option id/);
    await expect(
      db.tables.createRecord({
        table_id: schema.table.id,
        values: { [primary.id]: 'Bad user', [assignee.id]: 'disabled-or-unknown' },
        user_id: ownerId,
      }),
    ).rejects.toThrow(/active internal user/);
    await expect(
      db.tables.queryRecords(schema.table.id, {
        where: { combinator: 'and', clauses: null as never },
      }),
    ).rejects.toBeInstanceOf(TablesValidationError);
  });

  it('persists members, personal/shared views, and validated dashboard widgets', async () => {
    const { base, schema, primary } = await fixture();
    const status = await createStatusField(schema.table.id);
    const member = await db.tables.upsertBaseMember({
      base_id: base.id,
      user_id: teammateId,
      role: 'editor',
      added_by: ownerId,
    });
    expect(member.role).toBe('editor');

    const personal = await db.tables.createView({
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
    expect((await db.tables.listViews(schema.table.id, teammateId)).map((view) => view.id)).toContain(personal.id);
    expect((await db.tables.listViews(schema.table.id, ownerId)).map((view) => view.id)).not.toContain(personal.id);

    const dashboard = await db.tables.createDashboard({
      base_id: base.id,
      name: 'Launch pulse',
      created_by: ownerId,
    });
    const widget = await db.tables.createDashboardWidget({
      dashboard_id: dashboard.id,
      table_id: schema.table.id,
      type: 'bar',
      title: 'By status',
      config: { operation: 'count', groupByFieldId: status.id },
      created_by: ownerId,
    });
    expect(widget.type).toBe('bar');
    await expect(
      db.tables.createDashboardWidget({
        dashboard_id: dashboard.id,
        table_id: schema.table.id,
        type: 'unknown' as never,
        title: 'Invalid',
        created_by: ownerId,
      }),
    ).rejects.toThrow(/Unsupported dashboard widget type/);
  });

  it('publishes internal forms and executes idempotent notification automations', async () => {
    const { base, schema, primary } = await fixture();
    const status = await createStatusField(schema.table.id);
    const form = await db.tables.createForm({
      table_id: schema.table.id,
      name: 'Launch intake',
      status: 'published',
      config: {
        title: 'Launch request',
        fieldIds: [primary.id, status.id],
        successMessage: 'Request recorded.',
      },
      user_id: ownerId,
    });
    const submitted = await db.tables.submitForm(
      form.id,
      { [primary.id]: 'Form-created work', [status.id]: 'todo' },
      teammateId,
    );
    expect(submitted.created_by).toBe(teammateId);
    await expect(
      db.tables.submitForm(form.id, { [primary.id]: 'Unexpected', 999999: 'blocked' }, teammateId),
    ).rejects.toThrow(/not published/);

    const automation = await db.tables.createAutomationRule({
      base_id: base.id,
      table_id: schema.table.id,
      name: 'Notify teammate',
      status: 'enabled',
      trigger: 'record_created',
      config: {
        actions: [
          {
            type: 'notify',
            userIds: [teammateId],
            title: 'New launch item',
            message: 'A launch item was created.',
          },
        ],
      },
      execution_user_id: ownerId,
      user_id: ownerId,
    });
    const created = await db.tables.createRecord({
      table_id: schema.table.id,
      values: { [primary.id]: 'Automated item', [status.id]: 'todo' },
      user_id: ownerId,
    });
    expect(await db.tables.listAutomationRuns(automation.id)).toEqual([
      expect.objectContaining({ rule_id: automation.id, status: 'succeeded', actions_completed: 1 }),
    ]);
    expect(await db.tables.listNotifications(teammateId)).toEqual([
      expect.objectContaining({
        base_id: base.id,
        record_id: created.id,
        title: 'New launch item',
        read_at: null,
      }),
    ]);
    const notification = (await db.tables.listNotifications(teammateId))[0]!;
    expect((await db.tables.markNotificationRead(notification.id, teammateId))?.read_at).toEqual(expect.any(String));
    expect(await db.tables.markNotificationRead(notification.id, ownerId)).toBeUndefined();
  });

  it('accepts only active Drive files from the same Base and persists attachment edges', async () => {
    const { base, schema, primary } = await fixture();
    const attachments = await db.tables.createField({
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
    const record = await db.tables.createRecord({
      table_id: schema.table.id,
      values: { [primary.id]: 'Launch package', [attachments.id]: [pending.id] },
      user_id: ownerId,
    });
    expect(await db.tables.listRecordAttachments(record.id, attachments.id)).toEqual([
      expect.objectContaining({
        record_id: record.id,
        field_id: attachments.id,
        drive_file_id: pending.id,
        position: 0,
      }),
    ]);

    const otherBase = await db.tables.createBase({
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
      db.tables.createRecord({
        table_id: schema.table.id,
        values: { [primary.id]: 'Blocked package', [attachments.id]: [foreign.id] },
        user_id: ownerId,
      }),
    ).rejects.toThrow(/unavailable Base file/);

    await expect(
      db.tables.createRecord({
        table_id: schema.table.id,
        values: {
          [primary.id]: 'Legacy string handle',
          [attachments.id]: ['1750000000000-deadbeef.pdf'],
        },
        user_id: ownerId,
      }),
    ).rejects.toThrow(/expects Drive file ids/);

    await expect(
      db.tables.createForm({
        table_id: schema.table.id,
        name: 'Unsafe upload form',
        status: 'published',
        config: { fieldIds: [primary.id, attachments.id] },
        user_id: ownerId,
      }),
    ).rejects.toThrow(/non-attachment/);
  });
});
