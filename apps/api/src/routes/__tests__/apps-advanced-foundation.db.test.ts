/**
 * The Phase 2 foundation over HTTP (docs/specs/20261011-tables-apps-advanced.md
 * §8, F2; real PostgreSQL, rolled back per test): writing custom code into an
 * app needs the `apps_custom_code` flag (keeping a colleague's component does
 * not), a spec with custom cards cannot be published until the super review
 * gate exists, custom / external cards answer the placeholder, every Phase 2
 * route is mounted and answers `not_implemented`, the Phase 1 template routes
 * keep working, and nobody can create an `ai` field or write one's value yet.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppCard, AppDraftView, AppSpec } from '@greenhouse/types/apps';
import type { AppEnv } from '../../app-env.js';
import tablesRoutes from '../tables/index.js';
import appRoutes from '../apps.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let builder: UserRow;

let http: Hono<AppEnv>;

function send(user: UserRow, path: string, method = 'GET', body?: unknown) {
  return http.request(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': user.id },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = (await response.json()) as T;
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}

const NOT_IMPLEMENTED = { error: 'not_implemented', details: { notImplemented: true } };

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  [owner, builder] = await Promise.all(
    ['owner', 'builder'].map((who) =>
      createInternalTestUser(db, { email: `apps-f2-${who}-${tag}@test.local`, nickname: `F2 ${who}` }),
    ),
  );
  initializePlatformRuntime(db, [tablesRegistration]);
  const byId = new Map([owner, builder].map((user) => [user.id, user]));
  http = new Hono<AppEnv>();
  http.use('*', async (c, next) => {
    const user = byId.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  http.route('/api/tables', tablesRoutes);
  http.route('/api/apps', appRoutes);
});

afterEach(async () => {
  resetPlatformRuntimeForTests();
  await db.close();
  _resetProvider();
});

async function base() {
  const created = await json<{
    base: { id: number };
    schema: { table: { id: number }; fields: Array<{ id: number }> };
  }>(await send(owner, '/api/tables/bases', 'POST', { name: 'Tickets' }), 201);
  await json(
    await send(owner, `/api/tables/bases/${created.base.id}/members/${builder.id}`, 'PUT', { role: 'builder' }),
  );
  return { baseId: created.base.id, tableId: created.schema.table.id, primaryId: created.schema.fields[0]!.id };
}

function customCard(tableId: number, fieldId: number, html = '<div id="root"></div>'): AppCard {
  return {
    id: 'timeline',
    kind: 'custom',
    layout: { x: 0, y: 0, w: 12, h: 6 },
    html,
    bindings: [{ id: 'rows', kind: 'records', source: { tableId }, fieldIds: [fieldId] }],
  };
}

function specWith(tableId: number, ...cards: AppCard[]): AppSpec {
  return {
    version: 1,
    pages: [
      {
        id: 'home',
        title: 'Home',
        cards: [{ id: 'intro', kind: 'text', layout: { x: 0, y: 0, w: 12, h: 2 }, markdown: 'Hello' }, ...cards],
      },
    ],
    roles: [
      {
        key: 'member',
        name: 'Member',
        pages: 'all',
        tables: [{ tableId, access: 'read', fields: [], fieldDefault: 'visible' }],
      },
    ],
  };
}

describe('custom code is opt-in to write (apps_custom_code)', () => {
  it('refuses a new or changed component without the flag, and lets anyone keep one', async () => {
    const { baseId, tableId, primaryId } = await base();
    const withCustom = specWith(tableId, customCard(tableId, primaryId));

    // Team members are off by default.
    const refused = await json<{ details: Record<string, unknown> }>(
      await send(builder, '/api/apps', 'POST', { baseId, name: 'Board', spec: withCustom }),
      403,
    );
    expect(refused.details).toEqual({ reason: 'feature_disabled', feature: 'apps_custom_code' });

    await db.userFeatures.upsert({ user_id: owner.id, feature: 'apps_custom_code', enabled: true });
    const created = await json<AppDraftView>(
      await send(owner, '/api/apps', 'POST', { baseId, name: 'Board', spec: withCustom }),
      201,
    );
    expect(created.errors).toEqual([]);
    const appId = created.app.id;

    // The builder (no flag) edits the rest of the app; the component stays as it was.
    const kept = specWith(tableId, customCard(tableId, primaryId));
    kept.pages[0]!.cards[0] = { id: 'intro', kind: 'text', layout: { x: 0, y: 0, w: 12, h: 2 }, markdown: 'Changed' };
    const saved = await json<AppDraftView>(
      await send(builder, `/api/apps/${appId}/draft`, 'PUT', { spec: kept, draftRevision: 1 }),
    );
    expect(saved.draftRevision).toBe(2);

    // …but cannot change the component itself.
    const changed = specWith(tableId, customCard(tableId, primaryId, '<p>other</p>'));
    expect((await send(builder, `/api/apps/${appId}/draft`, 'PUT', { spec: changed, draftRevision: 2 })).status).toBe(
      403,
    );
  });
});

describe('placeholders until the slices land', () => {
  it('cannot publish custom code before the super review gate exists (D10)', async () => {
    const { baseId, tableId, primaryId } = await base();
    await db.userFeatures.upsert({ user_id: owner.id, feature: 'apps_custom_code', enabled: true });
    const created = await json<AppDraftView>(
      await send(owner, '/api/apps', 'POST', {
        baseId,
        name: 'Board',
        spec: specWith(tableId, customCard(tableId, primaryId)),
      }),
      201,
    );
    const published = await json<{ error: string; details: Record<string, unknown> }>(
      await send(owner, `/api/apps/${created.app.id}/publish`, 'POST', { draftRevision: 1 }),
      400,
    );
    expect(published).toEqual({
      error: 'not_implemented',
      details: { notImplemented: true, reason: 'custom_review' },
    });
  });

  it('answers not_implemented for custom and external cards, and on every Phase 2 route', async () => {
    const { baseId, tableId, primaryId } = await base();
    await db.userFeatures.upsert({ user_id: owner.id, feature: 'apps_custom_code', enabled: true });
    const external: AppCard = {
      id: 'issues',
      kind: 'external',
      layout: { x: 0, y: 6, w: 6, h: 4 },
      source: {
        kind: 'connector',
        server: 'github',
        tool: 'list_issues',
        input: {},
        map: { kind: 'kpi', value: '/total_count' },
      },
    };
    const created = await json<AppDraftView>(
      await send(owner, '/api/apps', 'POST', {
        baseId,
        name: 'Board',
        spec: specWith(tableId, customCard(tableId, primaryId), external),
      }),
      201,
    );
    const appId = created.app.id;
    for (const cardId of ['timeline', 'issues']) {
      expect(
        await json(
          await send(owner, `/api/apps/${appId}/cards/query`, 'POST', { pageId: 'home', cardId, draft: true }),
          400,
        ),
      ).toEqual(NOT_IMPLEMENTED);
    }

    const field = await db.tables.createField({
      table_id: tableId,
      name: 'Category',
      type: 'ai',
      created_by: owner.id,
    });
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/api/apps/reviews'],
      ['POST', `/api/apps/${appId}/versions/1/review`, { hash: 'x', decision: 'approve' }],
      ['POST', '/api/apps/templates', { appId, version: '1.0.0' }],
      ['GET', '/api/apps/templates/procurement'],
      ['POST', '/api/apps/templates/procurement/versions', { appId, version: '1.1.0', changelog: 'x' }],
      ['POST', '/api/apps/templates/procurement/versions/1.0.0/review', { decision: 'approve' }],
      ['POST', '/api/apps/templates/procurement/archive'],
      ['POST', `/api/tables/fields/${field.id}/ai/fill`],
      ['POST', `/api/tables/fields/${field.id}/ai/regenerate`, { recordIds: [1] }],
      ['GET', `/api/tables/fields/${field.id}/ai/status?recordIds=1,2`],
    ];
    for (const [method, path, body] of routes) {
      expect(await json(await send(owner, path, method, body), 400), `${method} ${path}`).toEqual(NOT_IMPLEMENTED);
    }
  });

  it('keeps the Phase 1 template catalog working', async () => {
    const list = await json<{ templates: Array<{ key: string }> }>(await send(owner, '/api/apps/templates'));
    expect(list.templates.map((template) => template.key)).toEqual(['procurement', 'it-tickets']);
  });

  it('refuses to create an ai field, and its value is never writable', async () => {
    const { tableId } = await base();
    expect(
      await json(
        await send(owner, `/api/tables/tables/${tableId}/fields`, 'POST', { name: 'Category', type: 'ai' }),
        400,
      ),
    ).toEqual(NOT_IMPLEMENTED);
    const field = await db.tables.createField({
      table_id: tableId,
      name: 'Category',
      type: 'ai',
      created_by: owner.id,
    });
    const written = await json<{ error: string }>(
      await send(owner, `/api/tables/tables/${tableId}/records`, 'POST', { values: { [field.id]: 'bug' } }),
      400,
    );
    expect(written.error).toMatch(/computed/);
  });
});
