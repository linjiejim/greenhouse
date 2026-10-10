/**
 * Tables foundation, API side (slice F-api, real PostgreSQL): the one access
 * resolver, the kernel `record.values` ceiling on every returned record, the
 * `/api/forms` router, the Base audit map, the realtime fan-out and
 * `canRecipientRead`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { FieldPolicy } from '@greenhouse/platform-kernel';
import type { TableBaseRole } from '@greenhouse/types/tables';
import type { ServerWsEvent } from '@greenhouse/types/ws';
import { nowIso } from '@greenhouse/utils/date';
import type { AppEnv } from '../../app-env.js';
import tablesRoutes from '../tables/index.js';
import formRoutes from '../forms.js';
import { tablesManifest } from '../../platform/manifests/tables.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { canRecipientRead } from '../../platform/tables/access.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { connectionManager } from '../../ws/connection-manager.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let editor: UserRow;
let outsider: UserRow;

type Connection = Parameters<typeof connectionManager.add>[0];
const connections: Connection[] = [];

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
  app.route('/api/forms', formRoutes);
  return app;
}

type App = ReturnType<typeof createHttpApp>;

function send(app: App, user: UserRow, path: string, method = 'GET', body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': user.id },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createBase(app: App, visibility: 'private' | 'team' = 'private') {
  const response = await send(app, owner, '/api/tables/bases', 'POST', { name: 'Foundation API Base', visibility });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    base: { id: number };
    schema: { table: { id: number }; fields: Array<{ id: number }> };
  };
}

async function addMember(app: App, baseId: number, user: UserRow, role: TableBaseRole) {
  const response = await send(app, owner, `/api/tables/bases/${baseId}/members/${user.id}`, 'PUT', { role });
  expect(response.status).toBe(200);
}

async function maskValues(user: UserRow, write: boolean) {
  const fields = Object.fromEntries(
    Object.keys(tablesManifest.entities.record!.fields).map((fieldId) => [
      fieldId,
      { read: fieldId === 'values' ? 'masked' : 'full', write, export: false } satisfies FieldPolicy,
    ]),
  );
  await db.platform.setUserEntityPolicyOverride({
    org_id: 'default',
    user_id: user.id,
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
}

function connect(user: UserRow): ServerWsEvent[] {
  const received: ServerWsEvent[] = [];
  const connection: Connection = {
    ws: {
      send: (data: string) => received.push(JSON.parse(data) as ServerWsEvent),
      close: () => undefined,
    } as unknown as Connection['ws'],
    userId: user.id,
    nickname: user.nickname,
    role: user.role,
    connectedAt: nowIso(),
    tokenAuthVersion: 0,
    tokenExp: Math.floor(Date.now() / 1000) + 3600,
  };
  connectionManager.add(connection);
  connections.push(connection);
  return received;
}

function recordsChanged(events: ServerWsEvent[]) {
  return events.filter((event) => event.type === 'tables:records_changed');
}

describe('Tables foundation — API access', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    [owner, editor, outsider] = await Promise.all([
      createInternalTestUser(db, { email: 'tables-fapi-owner@test.com' }),
      createInternalTestUser(db, { email: 'tables-fapi-editor@test.com' }),
      createInternalTestUser(db, { email: 'tables-fapi-outsider@test.com' }),
    ]);
    initializePlatformRuntime(db, [tablesRegistration]);
  });

  afterEach(async () => {
    for (const connection of connections.splice(0)) connectionManager.remove(connection);
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  it('strips stored and computed values from every record a masked reader gets back', async () => {
    const app = createHttpApp([owner, editor]);
    const created = await createBase(app);
    const tableId = created.schema.table.id;
    const primaryId = created.schema.fields[0]!.id;
    await addMember(app, created.base.id, editor, 'editor');
    const formula = await send(app, owner, `/api/tables/tables/${tableId}/fields`, 'POST', {
      name: 'Echo',
      type: 'formula',
      config: { formula: { resultType: 'text', expression: { type: 'field', fieldId: primaryId } } },
    });
    expect(formula.status).toBe(201);
    const formulaId = ((await formula.json()) as { field: { id: number } }).field.id;
    const record = (await (
      await send(app, owner, `/api/tables/tables/${tableId}/records`, 'POST', { values: { [primaryId]: 'Secret' } })
    ).json()) as { record: { id: number; computed_values: Record<string, unknown> } };
    expect(record.record.computed_values[String(formulaId)]).toBe('Secret');

    await maskValues(editor, true);
    const read = await send(app, editor, `/api/tables/tables/${tableId}/records/${record.record.id}`);
    expect(read.status).toBe(200);
    expect((await read.json()).record).toMatchObject({ id: record.record.id, values: {}, computed_values: {} });

    // Writing is allowed (write: true) but the response obeys the read ceiling too.
    const written = await send(app, editor, `/api/tables/tables/${tableId}/records`, 'POST', {
      values: { [primaryId]: 'Blind write' },
    });
    expect(written.status).toBe(201);
    expect((await written.json()).record).toMatchObject({ values: {}, computed_values: {} });

    // Queries still need full read, so filters cannot become an oracle.
    const query = await send(app, editor, `/api/tables/tables/${tableId}/records/query`, 'POST', {});
    expect(query.status).toBe(404);
  });

  it('resolves a custom grant without a loadable role to no access, and keeps team defaults read-only', async () => {
    const app = createHttpApp([owner, editor, outsider]);
    const created = await createBase(app, 'team');
    const tableId = created.schema.table.id;
    const primaryId = created.schema.fields[0]!.id;

    // Team default (viewer): can open, cannot write.
    expect((await send(app, outsider, `/api/tables/bases/${created.base.id}`)).status).toBe(200);
    const workspace = (await (await send(app, outsider, `/api/tables/bases/${created.base.id}`)).json()) as {
      role: string;
      access: { level: string };
    };
    expect(workspace).toMatchObject({ role: 'viewer', access: { level: 'viewer' } });
    const denied = await send(app, outsider, `/api/tables/tables/${tableId}/records`, 'POST', {
      values: { [primaryId]: 'No' },
    });
    expect(denied.status).toBe(404);

    // A custom member row outranks the team default and, until slice A loads
    // roles, resolves to none — never back to viewer (D13).
    await db.tables.upsertBaseMember({
      base_id: created.base.id,
      user_id: editor.id,
      role: 'custom' as TableBaseRole,
      added_by: owner.id,
    });
    expect((await send(app, editor, `/api/tables/bases/${created.base.id}`)).status).toBe(404);
    const listed = (await (await send(app, editor, '/api/tables/bases')).json()) as { bases: Array<{ id: number }> };
    expect(listed.bases.map((base) => base.id)).not.toContain(created.base.id);
  });

  it('serves the forms router outside the Tables routes, with explicit placeholders', async () => {
    const app = createHttpApp([owner, editor]);
    const created = await createBase(app);
    const tableId = created.schema.table.id;
    const primaryId = created.schema.fields[0]!.id;
    await addMember(app, created.base.id, editor, 'editor');
    const form = (await (
      await send(app, owner, `/api/tables/tables/${tableId}/forms`, 'POST', {
        name: 'Intake',
        status: 'published',
        config: { title: 'Intake', fieldIds: [primaryId], successMessage: 'Thanks!' },
      })
    ).json()) as { form: { id: number } };

    const open = await send(app, editor, `/api/forms/${form.form.id}`);
    expect(open.status).toBe(400);
    expect(await open.json()).toEqual({ error: 'not_implemented', details: { notImplemented: true } });
    expect((await send(app, editor, `/api/forms/${form.form.id}/uploads`, 'POST')).status).toBe(501);

    const submitted = await send(app, editor, `/api/forms/${form.form.id}/submit`, 'POST', {
      values: { [primaryId]: 'Via forms router' },
    });
    expect(submitted.status).toBe(201);
    expect(await submitted.json()).toEqual({ submitted: true, successMessage: 'Thanks!' });
  });

  it('places every audited action back in its own Base', async () => {
    const app = createHttpApp([owner]);
    const created = await createBase(app);
    const other = await createBase(app);
    const tableId = created.schema.table.id;
    const primaryId = created.schema.fields[0]!.id;
    const record = (await (
      await send(app, owner, `/api/tables/tables/${tableId}/records`, 'POST', { values: { [primaryId]: 'Row' } })
    ).json()) as { record: { id: number } };
    await send(app, owner, `/api/tables/tables/${tableId}/records/${record.record.id}`);
    await send(app, owner, `/api/tables/fields/${primaryId}`, 'PATCH', { name: 'Title' });
    await send(app, owner, `/api/tables/tables/${other.schema.table.id}/records`, 'POST', {
      values: { [other.schema.fields[0]!.id]: 'Elsewhere' },
    });

    const audit = await send(app, owner, `/api/tables/bases/${created.base.id}/audit`);
    expect(audit.status).toBe(200);
    const events = ((await audit.json()) as { events: Array<{ action_id: string; record_id: string | null }> }).events;
    expect(events.map((event) => event.action_id)).toEqual(
      expect.arrayContaining(['createRecord', 'getRecord', 'updateField']),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ action_id: 'getRecord', record_id: String(record.record.id) }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ action_id: 'createRecord', record_id: String(other.schema.table.id) }),
    );
  });

  it('tells online members — and only them — which records changed', async () => {
    const app = createHttpApp([owner, editor, outsider]);
    const created = await createBase(app);
    const tableId = created.schema.table.id;
    const primaryId = created.schema.fields[0]!.id;
    await addMember(app, created.base.id, editor, 'viewer');
    const ownerEvents = connect(owner);
    const editorEvents = connect(editor);
    const outsiderEvents = connect(outsider);

    const record = (await (
      await send(app, owner, `/api/tables/tables/${tableId}/records`, 'POST', { values: { [primaryId]: 'Live' } })
    ).json()) as { record: { id: number; revision: number } };
    const expected = {
      type: 'tables:records_changed',
      baseId: created.base.id,
      tableId,
      recordIds: [record.record.id],
    };
    expect(recordsChanged(ownerEvents)).toEqual([expected]);
    expect(recordsChanged(editorEvents)).toEqual([expected]);
    expect(recordsChanged(outsiderEvents)).toEqual([]);

    await send(app, owner, `/api/tables/tables/${tableId}/records/${record.record.id}`, 'PATCH', {
      revision: record.record.revision,
      values: { [primaryId]: 'Edited' },
    });
    expect(recordsChanged(editorEvents)).toHaveLength(2);
    expect(recordsChanged(outsiderEvents)).toEqual([]);
  });

  it('answers canRecipientRead through the same resolver and ceiling', async () => {
    const app = createHttpApp([owner, editor, outsider]);
    const created = await createBase(app);
    const tableId = created.schema.table.id;
    const primaryId = created.schema.fields[0]!.id;
    await addMember(app, created.base.id, editor, 'viewer');
    const record = (await (
      await send(app, owner, `/api/tables/tables/${tableId}/records`, 'POST', { values: { [primaryId]: 'Notify' } })
    ).json()) as { record: { id: number; table_id: number; revision: number } };
    const context = { db };

    expect(await canRecipientRead(context, owner.id, record.record)).toEqual({
      via: 'base',
      scope: { kind: 'full', userId: owner.id },
    });
    expect(await canRecipientRead(context, outsider.id, record.record)).toBeNull();

    await maskValues(editor, false);
    expect(await canRecipientRead(context, editor.id, record.record)).toEqual({
      via: 'base',
      scope: expect.objectContaining({ kind: 'scoped', tableId, readableFieldIds: [] }),
    });

    await send(app, owner, `/api/tables/tables/${tableId}/records/${record.record.id}?revision=1`, 'DELETE');
    expect(await canRecipientRead(context, owner.id, record.record)).toBeNull();
  });
});
