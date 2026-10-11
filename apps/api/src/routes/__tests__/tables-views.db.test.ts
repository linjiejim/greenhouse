/**
 * Tables views over HTTP (Phase 0 slice V, real PostgreSQL): `createView`
 * honours the type, `updateView` may change it, config errors are 400s,
 * `deleteView` follows the action table (own personal view: editor+; shared:
 * builder; someone else's personal view: invisible), and the aggregate
 * endpoint the grid's group headers and the kanban lane counts read.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { TableBaseRole } from '@greenhouse/types/tables';
import type { AppEnv } from '../../app-env.js';
import tablesRoutes from '../tables/index.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let builder: UserRow;
let editor: UserRow;
let viewer: UserRow;

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

type App = ReturnType<typeof createHttpApp>;

function send(app: App, user: UserRow, path: string, method = 'GET', body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': user.id },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

interface ViewBody {
  view: { id: number; type: string; scope: string; revision: number; config: string };
}

async function workspace(app: App) {
  const created = (await (await send(app, owner, '/api/tables/bases', 'POST', { name: 'Views API Base' })).json()) as {
    base: { id: number };
    schema: { table: { id: number }; fields: Array<{ id: number }> };
  };
  const baseId = created.base.id;
  const tableId = created.schema.table.id;
  const primaryId = created.schema.fields[0]!.id;
  const stage = (await (
    await send(app, owner, `/api/tables/tables/${tableId}/fields`, 'POST', {
      name: 'Stage',
      type: 'single_select',
      config: {
        options: [
          { id: 'lead', label: 'Lead' },
          { id: 'won', label: 'Won' },
        ],
      },
    })
  ).json()) as { field: { id: number } };
  const due = (await (
    await send(app, owner, `/api/tables/tables/${tableId}/fields`, 'POST', { name: 'Due', type: 'date' })
  ).json()) as { field: { id: number } };
  for (const [user, role] of [
    [builder, 'builder'],
    [editor, 'editor'],
    [viewer, 'viewer'],
  ] as Array<[UserRow, TableBaseRole]>) {
    const response = await send(app, owner, `/api/tables/bases/${baseId}/members/${user.id}`, 'PUT', { role });
    expect(response.status).toBe(200);
  }
  return { baseId, tableId, primaryId, stageId: stage.field.id, dueId: due.field.id };
}

async function createView(app: App, user: UserRow, tableId: number, body: Record<string, unknown>) {
  return send(app, user, `/api/tables/tables/${tableId}/views`, 'POST', body);
}

describe('Tables views API', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    [owner, builder, editor, viewer] = await Promise.all([
      createInternalTestUser(db, { email: 'tables-views-owner@test.com' }),
      createInternalTestUser(db, { email: 'tables-views-builder@test.com' }),
      createInternalTestUser(db, { email: 'tables-views-editor@test.com' }),
      createInternalTestUser(db, { email: 'tables-views-viewer@test.com' }),
    ]);
    initializePlatformRuntime(db, [tablesRegistration]);
  });

  afterEach(async () => {
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  it('creates a view of the requested type and lets updateView change it', async () => {
    const app = createHttpApp([owner, builder, editor, viewer]);
    const ws = await workspace(app);

    const kanban = await createView(app, builder, ws.tableId, {
      name: 'Pipeline',
      scope: 'shared',
      type: 'kanban',
      config: { kanban: { groupFieldId: ws.stageId }, fieldIds: [ws.primaryId] },
    });
    expect(kanban.status).toBe(201);
    const created = ((await kanban.json()) as ViewBody).view;
    expect(created).toMatchObject({ type: 'kanban', scope: 'shared' });
    expect(JSON.parse(created.config)).toEqual({
      version: 1,
      fieldIds: [ws.primaryId],
      kanban: { groupFieldId: ws.stageId },
    });

    const missing = await createView(app, builder, ws.tableId, { name: 'Broken', scope: 'shared', type: 'calendar' });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toMatch(/date field/);
    expect(
      (await createView(app, builder, ws.tableId, { name: 'Odd', scope: 'shared', type: 'timeline' })).status,
    ).toBe(400);

    const toCalendar = await send(app, builder, `/api/tables/views/${created.id}`, 'PATCH', {
      revision: created.revision,
      type: 'calendar',
      config: { ...JSON.parse(created.config), calendar: { startFieldId: ws.dueId } },
    });
    expect(toCalendar.status).toBe(200);
    const calendar = ((await toCalendar.json()) as ViewBody).view;
    expect(calendar.type).toBe('calendar');
    // The lanes stay with the view for the day it becomes a kanban again.
    expect(JSON.parse(calendar.config)).toMatchObject({
      calendar: { startFieldId: ws.dueId },
      kanban: { groupFieldId: ws.stageId },
    });
  });

  it('deletes views by the action table: own personal for editor+, shared for builder', async () => {
    const app = createHttpApp([owner, builder, editor, viewer]);
    const ws = await workspace(app);

    // A viewer has no personal views to delete: it cannot make one.
    expect((await createView(app, viewer, ws.tableId, { name: 'Mine', scope: 'personal' })).status).toBe(404);
    // An editor cannot share a view.
    expect((await createView(app, editor, ws.tableId, { name: 'Ours', scope: 'shared' })).status).toBe(404);

    const personal = (
      (await (
        await createView(app, editor, ws.tableId, { name: 'Mine', scope: 'personal', type: 'grid' })
      ).json()) as ViewBody
    ).view;
    const shared = (
      (await (await createView(app, builder, ws.tableId, { name: 'Team', scope: 'shared' })).json()) as ViewBody
    ).view;

    // Nobody else — not even the Base owner — can see, let alone delete, a personal view.
    expect((await send(app, owner, `/api/tables/views/${personal.id}`, 'DELETE')).status).toBe(404);
    expect((await send(app, builder, `/api/tables/views/${personal.id}`, 'DELETE')).status).toBe(404);
    // Editors and viewers cannot delete a shared view.
    expect((await send(app, editor, `/api/tables/views/${shared.id}`, 'DELETE')).status).toBe(404);
    expect((await send(app, viewer, `/api/tables/views/${shared.id}`, 'DELETE')).status).toBe(404);

    const ownDelete = await send(app, editor, `/api/tables/views/${personal.id}`, 'DELETE');
    expect(ownDelete.status).toBe(200);
    expect(((await ownDelete.json()) as ViewBody).view.id).toBe(personal.id);
    expect(await db.tables.getView(personal.id)).toBeUndefined();

    expect((await send(app, builder, `/api/tables/views/${shared.id}`, 'DELETE')).status).toBe(200);
    expect((await send(app, builder, `/api/tables/views/${shared.id}`, 'DELETE')).status).toBe(404);

    // An editor demoted to viewer loses the right to touch the personal views it still has.
    const kept = (
      (await (await createView(app, editor, ws.tableId, { name: 'Kept', scope: 'personal' })).json()) as ViewBody
    ).view;
    await send(app, owner, `/api/tables/bases/${ws.baseId}/members/${editor.id}`, 'PUT', { role: 'viewer' });
    expect((await send(app, editor, `/api/tables/views/${kept.id}`, 'DELETE')).status).toBe(404);
    expect(await db.tables.getView(kept.id)).toBeDefined();
  });

  it('counts records per group for group headers and kanban lanes', async () => {
    const app = createHttpApp([owner, builder, editor, viewer]);
    const ws = await workspace(app);
    for (const stage of ['lead', 'lead', 'won', null]) {
      const response = await send(app, editor, `/api/tables/tables/${ws.tableId}/records`, 'POST', {
        values: { [ws.primaryId]: `Deal ${stage}`, ...(stage ? { [ws.stageId]: stage } : {}) },
      });
      expect(response.status).toBe(201);
    }
    const response = await send(app, viewer, `/api/tables/tables/${ws.tableId}/records/aggregate`, 'POST', {
      operation: 'count',
      groupBy: { fieldId: ws.stageId },
      sort: 'group_asc',
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { rows: unknown[] }).rows).toEqual([
      { group: 'lead', value: 2 },
      { group: 'won', value: 1 },
      { group: null, value: 1 },
    ]);
  });
});
