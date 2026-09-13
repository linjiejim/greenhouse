/**
 * Tables Platform/HTTP/Agent parity and IDOR integration tests (real PostgreSQL).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import type { AppEnv } from '../../app-env.js';
import tablesRoutes from '../tables.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { tablesManifest } from '../../platform/manifests/tables.js';
import type { FieldPolicy } from '@greenhouse/platform-kernel';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { createTablesMutationTool } from '../../tools/tables-mutation.js';
import { createTablesQueryTool } from '../../tools/tables-query.js';
import { createExportDataTool } from '../../tools/export-data.js';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { deleteObjectAtKey, getObjectAtKey } from '../../storage/uploads.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let editor: UserRow;
let outsider: UserRow;
let editorReady: Promise<UserRow> | undefined;
let outsiderReady: Promise<UserRow> | undefined;

async function createUser(email: string) {
  return createInternalTestUser(db, { email });
}

function setupEditor(): Promise<UserRow> {
  editorReady ??= createUser('tables-editor-api@test.com').then((created) => {
    editor = created;
    return created;
  });
  return editorReady;
}

function setupOutsider(): Promise<UserRow> {
  outsiderReady ??= createUser('tables-outsider-api@test.com').then((created) => {
    outsider = created;
    return created;
  });
  return outsiderReady;
}

function createHttpApp(users: UserRow[]) {
  const byId = new Map(users.map((user) => [user.id, user]));
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const user = byId.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  app.route('/api/tables', tablesRoutes);
  return app;
}

async function executeTool(tool: unknown, input: unknown): Promise<unknown> {
  const executable = tool as {
    execute: (value: unknown, options: { toolCallId: string; messages: never[] }) => Promise<unknown>;
  };
  return executable.execute(input, { toolCallId: 'tables-platform-test', messages: [] });
}

async function createBase(app: ReturnType<typeof createHttpApp>) {
  const response = await app.request('/api/tables/bases', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
    body: JSON.stringify({ name: 'Operations Base', visibility: 'private' }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    base: { id: number };
    schema: {
      table: { id: number; schema_revision: number };
      fields: Array<{ id: number }>;
      views: Array<{ id: number; revision: number }>;
    };
  };
}

describe('Tables Platform application', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    owner = await createUser('tables-owner-api@test.com');
    editorReady = undefined;
    outsiderReady = undefined;
    initializePlatformRuntime(db, [tablesRegistration]);
  });

  afterEach(async () => {
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  it('intersects Base roles with Platform policy and preserves private non-disclosure', async () => {
    await Promise.all([setupEditor(), setupOutsider()]);
    const app = createHttpApp([owner, editor, outsider]);
    const created = await createBase(app);

    const privateRead = await app.request(`/api/tables/bases/${created.base.id}`, {
      headers: { 'x-test-user': outsider.id },
    });
    expect(privateRead.status).toBe(404);
    const outsiderSession = await db.sessions.create('Denied Tables export', 'team', outsider.id);
    const deniedExport = (await executeTool(
      createExportDataTool(db, { userId: outsider.id, sessionId: outsiderSession.id }),
      {
        source: { type: 'tables_records', table_id: created.schema.table.id },
        format: 'csv',
      },
    )) as { error: string };
    expect(deniedExport.error).toMatch(/Table not found/);
    expect(await db.chatFiles.listBySession(outsiderSession.id)).toEqual([]);

    const member = await app.request(`/api/tables/bases/${created.base.id}/members/${editor.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ role: 'editor' }),
    });
    expect(member.status).toBe(200);

    const editorSchemaMutation = await app.request(`/api/tables/tables/${created.schema.table.id}/fields`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': editor.id },
      body: JSON.stringify({ name: 'Must fail', type: 'text' }),
    });
    expect(editorSchemaMutation.status).toBe(404);

    const editorRecord = await app.request(`/api/tables/tables/${created.schema.table.id}/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': editor.id },
      body: JSON.stringify({ values: { [created.schema.fields[0]!.id]: 'Editor-created' } }),
    });
    expect(editorRecord.status).toBe(201);

    const visible = await app.request(`/api/tables/bases/${created.base.id}`, {
      headers: { 'x-test-user': editor.id },
    });
    expect(visible.status).toBe(200);
    expect((await visible.json()).role).toBe('editor');
  });

  it('applies Platform deny before owner/editor Base permissions and audits the denial', async () => {
    const app = createHttpApp([owner]);
    const created = await createBase(app);
    await db.platform.setUserCapabilityOverride({
      org_id: 'default',
      user_id: owner.id,
      capability: 'tables.data.create',
      effect: 'deny',
      granted_by: owner.id,
      reason: 'Test deny',
    });

    const response = await app.request(`/api/tables/tables/${created.schema.table.id}/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ values: { [created.schema.fields[0]!.id]: 'Denied' } }),
    });
    expect(response.status).toBe(403);
    expect(await db.tables.queryRecords(created.schema.table.id)).toMatchObject({ total: 0 });

    const audits = await db.platform.listAuditEvents('default');
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor_id: owner.id,
          app_id: 'tables',
          action_id: 'createRecord',
          result: 'denied',
        }),
      ]),
    );
  });

  it('keeps HTTP and Agent tool record paths on the same runtime authorization and revisions', async () => {
    await setupEditor();
    const app = createHttpApp([owner, editor]);
    const created = await createBase(app);
    await app.request(`/api/tables/bases/${created.base.id}/members/${editor.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ role: 'editor' }),
    });
    const primaryId = created.schema.fields[0]!.id;

    const mutation = (await executeTool(createTablesMutationTool({ userId: editor.id }), {
      action: 'records.create',
      table_id: created.schema.table.id,
      values: { [primaryId]: 'Agent-created' },
    })) as { record: { id: number; revision: number } };
    expect(mutation.record).toMatchObject({ revision: 1 });

    const query = (await executeTool(createTablesQueryTool({ userId: owner.id }), {
      action: 'records.query',
      table_id: created.schema.table.id,
    })) as { records: Array<{ id: number; values: Record<string, unknown> }> };
    expect(query.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: mutation.record.id,
          values: expect.objectContaining({ [primaryId]: 'Agent-created' }),
        }),
      ]),
    );

    const stale = await app.request(`/api/tables/tables/${created.schema.table.id}/records/${mutation.record.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': editor.id },
      body: JSON.stringify({ revision: 999, values: { [primaryId]: 'Stale' } }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).details).toMatchObject({ currentRevision: 1 });
  });

  it('exports authorized multidimensional table records through the generic data tool', async () => {
    const app = createHttpApp([owner]);
    const created = await createBase(app);
    const primaryId = created.schema.fields[0]!.id;
    await app.request(`/api/tables/tables/${created.schema.table.id}/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ values: { [primaryId]: '可导出的记录' } }),
    });
    const session = await db.sessions.create('Tables export', 'team', owner.id);

    const artifact = (await executeTool(createExportDataTool(db, { userId: owner.id, sessionId: session.id }), {
      source: { type: 'tables_records', table_id: created.schema.table.id },
      format: 'csv',
    })) as {
      type: string;
      file_id: string;
      name: string;
      size: number;
      row_count: number;
    };
    expect(artifact).toMatchObject({
      type: 'file',
      name: expect.stringMatching(/\.csv$/),
      row_count: 1,
    });
    const file = await db.chatFiles.getById(artifact.file_id);
    expect(file).toMatchObject({ session_id: session.id, size: artifact.size });
    const object = await getObjectAtKey(file!.storage_key);
    expect(object!.buffer.toString('utf8')).toContain('可导出的记录');
    await deleteObjectAtKey(file!.storage_key);
  });

  it('exposes immutable schema snapshots, batch validation, and revision conflicts through HTTP', async () => {
    const app = createHttpApp([owner]);
    const created = await createBase(app);
    expect(created.schema.table.schema_revision).toBe(1);

    const fieldResponse = await app.request(`/api/tables/tables/${created.schema.table.id}/fields`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({
        name: 'Status',
        type: 'single_select',
        config: { options: [{ id: 'open', label: 'Open' }] },
      }),
    });
    expect(fieldResponse.status).toBe(201);
    const field = (await fieldResponse.json()).field as { id: number };

    const versionsResponse = await app.request(`/api/tables/tables/${created.schema.table.id}/schema/versions`, {
      headers: { 'x-test-user': owner.id },
    });
    expect(versionsResponse.status).toBe(200);
    const versions = (await versionsResponse.json()).versions as Array<{ version: number; change_type: string }>;
    expect(versions).toMatchObject([
      { version: 2, change_type: 'field_created' },
      { version: 1, change_type: 'created' },
    ]);

    const snapshotResponse = await app.request(`/api/tables/tables/${created.schema.table.id}/schema/versions/2`, {
      headers: { 'x-test-user': owner.id },
    });
    expect(snapshotResponse.status).toBe(200);
    expect((await snapshotResponse.json()).version.schema_snapshot.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: field.id, name: 'Status' })]),
    );

    const primaryId = created.schema.fields[0]!.id;
    const validationResponse = await app.request(
      `/api/tables/tables/${created.schema.table.id}/records/batch-validate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
        body: JSON.stringify({
          items: [
            { values: { [primaryId]: 'Valid', [field.id]: 'open' } },
            { values: { [primaryId]: 'Invalid', [field.id]: 'missing' } },
          ],
        }),
      },
    );
    expect(validationResponse.status).toBe(200);
    expect((await validationResponse.json()).results).toEqual([
      { index: 0, ok: true },
      expect.objectContaining({ index: 1, ok: false, reason: 'invalid' }),
    ]);

    const view = created.schema.views[0]!;
    const updateView = await app.request(`/api/tables/views/${view.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ revision: view.revision, name: 'Updated grid' }),
    });
    expect(updateView.status).toBe(200);
    expect((await updateView.json()).view).toMatchObject({ revision: 2, name: 'Updated grid' });
    const staleView = await app.request(`/api/tables/views/${view.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ revision: view.revision, name: 'Stale grid' }),
    });
    expect(staleView.status).toBe(409);
    expect((await staleView.json()).details).toEqual({ currentRevision: 2 });
  });

  it('keeps personal views private even from another Base builder', async () => {
    await setupEditor();
    const app = createHttpApp([owner, editor]);
    const created = await createBase(app);
    await app.request(`/api/tables/bases/${created.base.id}/members/${editor.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ role: 'builder' }),
    });
    const personalResponse = await app.request(`/api/tables/tables/${created.schema.table.id}/views`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ name: 'Owner only', scope: 'personal' }),
    });
    expect(personalResponse.status).toBe(201);
    const personal = (await personalResponse.json()).view as { id: number; revision: number };

    const denied = await app.request(`/api/tables/views/${personal.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': editor.id },
      body: JSON.stringify({ revision: personal.revision, name: 'Hijacked' }),
    });
    expect(denied.status).toBe(404);
    expect(await db.tables.getView(personal.id, owner.id)).toMatchObject({ name: 'Owner only' });
  });

  it('enforces record values field policy on query and mutation paths', async () => {
    await setupEditor();
    const app = createHttpApp([owner, editor]);
    const created = await createBase(app);
    await app.request(`/api/tables/bases/${created.base.id}/members/${editor.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ role: 'editor' }),
    });
    const fields = Object.fromEntries(
      Object.keys(tablesManifest.entities.record.fields).map((fieldId) => [
        fieldId,
        {
          read: fieldId === 'values' ? ('none' as const) : ('full' as const),
          write: fieldId !== 'values',
          export: false,
        } satisfies FieldPolicy,
      ]),
    );
    await db.platform.setUserEntityPolicyOverride({
      org_id: 'default',
      user_id: editor.id,
      effect: 'allow',
      policy: {
        app_id: 'tables',
        module_id: 'data',
        entity_id: 'record',
        scopes: [{ kind: 'all' }],
        field_policies: fields,
      },
      granted_by: owner.id,
    });
    const primaryId = created.schema.fields[0]!.id;

    const query = await app.request(`/api/tables/tables/${created.schema.table.id}/records`, {
      headers: { 'x-test-user': editor.id },
    });
    expect(query.status).toBe(404);
    const create = await app.request(`/api/tables/tables/${created.schema.table.id}/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': editor.id },
      body: JSON.stringify({ values: { [primaryId]: 'Must not write' } }),
    });
    expect(create.status).toBe(404);
  });

  it('publishes authenticated forms and exposes automation notifications through governed routes', async () => {
    await setupEditor();
    const app = createHttpApp([owner, editor]);
    const created = await createBase(app);
    await app.request(`/api/tables/bases/${created.base.id}/members/${editor.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ role: 'editor' }),
    });
    const primaryId = created.schema.fields[0]!.id;
    const formResponse = await app.request(`/api/tables/tables/${created.schema.table.id}/forms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({
        name: 'Internal intake',
        status: 'published',
        config: { title: 'Internal intake', fieldIds: [primaryId] },
      }),
    });
    expect(formResponse.status).toBe(201);
    const form = (await formResponse.json()).form as { id: number };
    const submission = await app.request(`/api/tables/forms/${form.id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': editor.id },
      body: JSON.stringify({ values: { [primaryId]: 'Submitted by form' } }),
    });
    expect(submission.status).toBe(201);

    const ruleResponse = await app.request(`/api/tables/bases/${created.base.id}/automations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({
        tableId: created.schema.table.id,
        name: 'Notify editor',
        status: 'enabled',
        trigger: 'record_created',
        config: {
          actions: [{ type: 'notify', userIds: [editor.id], title: 'New item', message: 'A record was created.' }],
        },
      }),
    });
    expect(ruleResponse.status).toBe(201);
    const rule = (await ruleResponse.json()).automation as { id: number };
    const recordResponse = await app.request(`/api/tables/tables/${created.schema.table.id}/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ values: { [primaryId]: 'Triggers notification' } }),
    });
    expect(recordResponse.status).toBe(201);

    const runs = await app.request(`/api/tables/automations/${rule.id}/runs`, {
      headers: { 'x-test-user': owner.id },
    });
    expect(runs.status).toBe(200);
    expect((await runs.json()).runs).toEqual([
      expect.objectContaining({ rule_id: rule.id, status: 'succeeded', actions_completed: 1 }),
    ]);
    const notifications = await app.request('/api/tables/notifications', {
      headers: { 'x-test-user': editor.id },
    });
    expect(notifications.status).toBe(200);
    expect((await notifications.json()).notifications).toEqual([
      expect.objectContaining({ user_id: editor.id, title: 'New item', read_at: null }),
    ]);
  });

  it('archives a table only for the Base creator and leaves its records recoverable', async () => {
    await Promise.all([setupEditor(), setupOutsider()]);
    const app = createHttpApp([owner, editor, outsider]);
    const created = await createBase(app);
    const tableId = created.schema.table.id;
    const primaryId = created.schema.fields[0]!.id;

    // A builder can create and rename tables but must not be able to remove one.
    const promoted = await app.request(`/api/tables/bases/${created.base.id}/members/${editor.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ role: 'builder' }),
    });
    expect(promoted.status).toBe(200);
    const builderAttempt = await app.request(`/api/tables/tables/${tableId}/archive`, {
      method: 'POST',
      headers: { 'x-test-user': editor.id },
    });
    expect(builderAttempt.status).toBe(404);
    expect(await db.tables.getTable(tableId)).toMatchObject({ archived_at: null });

    const record = await app.request(`/api/tables/tables/${tableId}/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ values: { [primaryId]: 'Survives the archive' } }),
    });
    expect(record.status).toBe(201);

    const archived = await app.request(`/api/tables/tables/${tableId}/archive`, {
      method: 'POST',
      headers: { 'x-test-user': owner.id },
    });
    expect(archived.status).toBe(200);

    // Gone from the Base, but the rows are still there for a CLI restore.
    const workspace = await app.request(`/api/tables/bases/${created.base.id}`, {
      headers: { 'x-test-user': owner.id },
    });
    expect((await workspace.json()).tables).toEqual([]);
    expect(await db.tables.listArchivedTables(created.base.id)).toEqual([
      expect.objectContaining({ id: tableId, archived_at: expect.any(String) }),
    ]);
    expect(await db.tables.queryRecords(tableId)).toMatchObject({ total: 1 });

    const restored = await db.tables.restoreTable(tableId);
    expect(restored).toMatchObject({ id: tableId, archived_at: null });
    expect(await db.tables.listTables(created.base.id)).toEqual([expect.objectContaining({ id: tableId })]);
  });

  it('lists and restores soft-deleted records for editors', async () => {
    await setupEditor();
    const app = createHttpApp([owner, editor]);
    const created = await createBase(app);
    const tableId = created.schema.table.id;
    const primaryId = created.schema.fields[0]!.id;
    const member = await app.request(`/api/tables/bases/${created.base.id}/members/${editor.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ role: 'editor' }),
    });
    expect(member.status).toBe(200);

    const created1 = await app.request(`/api/tables/tables/${tableId}/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': editor.id },
      body: JSON.stringify({ values: { [primaryId]: 'Deleted by mistake' } }),
    });
    const record = (await created1.json()).record as { id: number; revision: number };

    const deleted = await app.request(
      `/api/tables/tables/${tableId}/records/${record.id}?revision=${record.revision}`,
      { method: 'DELETE', headers: { 'x-test-user': editor.id } },
    );
    expect(deleted.status).toBe(200);
    expect(await db.tables.queryRecords(tableId)).toMatchObject({ total: 0 });

    const bin = await app.request(`/api/tables/tables/${tableId}/records/deleted`, {
      headers: { 'x-test-user': editor.id },
    });
    expect(bin.status).toBe(200);
    expect((await bin.json()).records).toEqual([expect.objectContaining({ id: record.id })]);

    const restored = await app.request(`/api/tables/tables/${tableId}/records/${record.id}/restore`, {
      method: 'POST',
      headers: { 'x-test-user': editor.id },
    });
    expect(restored.status).toBe(200);
    expect(await db.tables.queryRecords(tableId)).toMatchObject({ total: 1 });
    // Restoring bumps the revision, so a stale client cannot silently overwrite.
    expect((await restored.json()).record.revision).toBeGreaterThan(record.revision);
  });

  it('deletes a dashboard for the creator only, and really deletes it', async () => {
    await setupEditor();
    const app = createHttpApp([owner, editor]);
    const created = await createBase(app);
    const promoted = await app.request(`/api/tables/bases/${created.base.id}/members/${editor.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ role: 'builder' }),
    });
    expect(promoted.status).toBe(200);

    const dashboardResponse = await app.request(`/api/tables/bases/${created.base.id}/dashboards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ name: 'Weekly numbers' }),
    });
    expect(dashboardResponse.status).toBe(201);
    const dashboard = (await dashboardResponse.json()).dashboard as { id: number };

    const builderAttempt = await app.request(`/api/tables/dashboards/${dashboard.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user': editor.id },
    });
    expect(builderAttempt.status).toBe(404);
    expect(await db.tables.getDashboard(dashboard.id)).toBeTruthy();

    const removed = await app.request(`/api/tables/dashboards/${dashboard.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user': owner.id },
    });
    expect(removed.status).toBe(200);
    expect(await db.tables.getDashboard(dashboard.id)).toBeUndefined();
  });
});
