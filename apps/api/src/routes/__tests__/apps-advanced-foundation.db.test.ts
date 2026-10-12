/**
 * The Phase 2 foundation over HTTP (docs/specs/20261011-tables-apps-advanced.md
 * §8, F2; real PostgreSQL, rolled back per test): writing custom code into an
 * app needs the `apps_custom_code` flag (keeping a colleague's component does
 * not). The implemented slices have separate gateway/worker/lifecycle suites.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type {
  AppCard,
  AppDraftView,
  AppSpec,
  AppCustomReviewItem,
  AppVersionSummary,
  AppRuntimeView,
  AppCardQueryResult,
} from '@greenhouse/types/apps';
import type { AppEnv } from '../../app-env.js';
import tablesRoutes from '../tables/index.js';
import appRoutes from '../apps.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let builder: UserRow;
let admin: UserRow;
let viewer: UserRow;

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

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  [owner, builder] = await Promise.all(
    ['owner', 'builder'].map((who) =>
      createInternalTestUser(db, { email: `apps-f2-${who}-${tag}@test.local`, nickname: `F2 ${who}` }),
    ),
  );
  admin = await createInternalTestUser(db, { email: `apps-admin-${tag}@test.local`, role: 'super' });
  viewer = await createInternalTestUser(db, { email: `apps-viewer-${tag}@test.local` });
  initializePlatformRuntime(db, [tablesRegistration]);
  const byId = new Map([owner, builder, admin, viewer].map((user) => [user.id, user]));
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
  it('checks the custom-code grant when restoring a version into the draft', async () => {
    const { baseId, tableId, primaryId } = await base();
    await db.userFeatures.upsert({ user_id: owner.id, feature: 'apps_custom_code', enabled: true });
    const created = await json<AppDraftView>(
      await send(owner, '/api/apps', 'POST', {
        baseId,
        name: 'Restored board',
        spec: specWith(tableId, customCard(tableId, primaryId)),
      }),
      201,
    );
    // A historical version, before the current draft removed its custom code.
    await db.tables.publishApp(created.app.id, { draftRevision: 1, publishedBy: owner.id });
    await json(
      await send(owner, `/api/apps/${created.app.id}/draft`, 'PUT', {
        spec: specWith(tableId),
        draftRevision: 1,
      }),
    );
    const path = `/api/apps/${created.app.id}/versions/1/restore`;
    const refused = await json<{ details: Record<string, unknown> }>(
      await send(builder, path, 'POST', { draftRevision: 2 }),
      403,
    );
    expect(refused.details).toEqual({ reason: 'feature_disabled', feature: 'apps_custom_code' });
    expect((await db.tables.getApp(created.app.id))?.draft_revision).toBe(2);
    await db.userFeatures.upsert({ user_id: builder.id, feature: 'apps_custom_code', enabled: true });
    const restored = await json<AppDraftView>(await send(builder, path, 'POST', { draftRevision: 2 }));
    expect(restored.spec.pages[0]!.cards.some((card) => card.kind === 'custom')).toBe(true);
    // Keeping exactly the same component remains allowed after the grant is removed.
    await db.userFeatures.upsert({ user_id: builder.id, feature: 'apps_custom_code', enabled: false });
    expect((await send(builder, path, 'POST', { draftRevision: 3 })).status).toBe(200);
  });

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

describe('custom component review and binding gateway', () => {
  async function draft() {
    const ids = await base();
    await db.userFeatures.upsert({ user_id: owner.id, feature: 'apps_custom_code', enabled: true });
    const spec = specWith(ids.tableId, customCard(ids.tableId, ids.primaryId));
    const created = await json<AppDraftView>(
      await send(owner, '/api/apps', 'POST', { baseId: ids.baseId, name: 'Custom', spec }),
      201,
    );
    return { ...ids, appId: created.app.id, spec };
  }
  async function review(appId: number, version: AppVersionSummary, decision: 'approve' | 'reject' = 'approve') {
    return json(
      await send(admin, `/api/apps/${appId}/versions/${version.version}/review`, 'POST', {
        hash: version.specHash,
        decision,
      }),
    );
  }
  it('stages an immutable review without moving the live pointer and revokes all copies of a hash', async () => {
    const p = await draft();
    await json(
      await send(owner, `/api/apps/${p.appId}/audiences`, 'PUT', {
        entries: [{ principal: { type: 'user', userId: viewer.id }, roleKey: 'member' }],
        audiencesRevision: 1,
      }),
    );
    const staged = await json<{ pendingReview: boolean; version: AppVersionSummary }>(
      await send(owner, `/api/apps/${p.appId}/publish`, 'POST', { draftRevision: 1 }),
    );
    expect(staged.pendingReview).toBe(true);
    expect((await db.tables.getApp(p.appId))?.published_version).toBeNull();
    expect((await send(viewer, `/api/apps/${p.appId}`)).status).toBe(404);
    expect((await send(owner, '/api/apps/reviews')).status).toBe(403);
    const queue = await json<{ items: AppCustomReviewItem[] }>(await send(admin, '/api/apps/reviews'));
    expect(queue.items.find((item) => item.app.id === p.appId)?.cards[0]?.bindings[0]?.id).toBe('rows');
    expect(
      (
        await send(admin, `/api/apps/${p.appId}/versions/1/review`, 'POST', {
          hash: 'a'.repeat(64),
          decision: 'approve',
        })
      ).status,
    ).toBe(409);
    await review(p.appId, staged.version);
    expect((await send(viewer, `/api/apps/${p.appId}`)).status).toBe(404);
    const active = await json<{ pendingReview?: boolean; version: AppVersionSummary }>(
      await send(owner, `/api/apps/${p.appId}/publish`, 'POST', { draftRevision: 1 }),
    );
    expect(active.pendingReview).toBeUndefined();
    expect(active.version.version).toBeGreaterThan(staged.version.version);
    expect((await send(viewer, `/api/apps/${p.appId}`)).status).toBe(200);
    await review(p.appId, staged.version, 'reject');
    expect((await send(viewer, `/api/apps/${p.appId}`)).status).toBe(404);
  });

  it('requires review when private code gains an audience and preserves the old live version on an edit', async () => {
    const p = await draft();
    const live = await json<{ version: AppVersionSummary }>(
      await send(owner, `/api/apps/${p.appId}/publish`, 'POST', { draftRevision: 1 }),
    );
    const audience = { entries: [{ principal: { type: 'team' }, roleKey: 'member' }], audiencesRevision: 1 };
    expect((await send(owner, `/api/apps/${p.appId}/audiences`, 'PUT', audience)).status).toBe(403);
    await review(p.appId, live.version);
    await json(await send(owner, `/api/apps/${p.appId}/audiences`, 'PUT', audience));
    const edited = specWith(p.tableId, customCard(p.tableId, p.primaryId, '<p>New code</p>'));
    await json(await send(owner, `/api/apps/${p.appId}/draft`, 'PUT', { spec: edited, draftRevision: 1 }));
    const staged = await json<{ pendingReview: boolean }>(
      await send(owner, `/api/apps/${p.appId}/publish`, 'POST', { draftRevision: 2 }),
    );
    expect(staged.pendingReview).toBe(true);
    const view = await json<AppRuntimeView>(await send(viewer, `/api/apps/${p.appId}`));
    expect(view.version).toBe(live.version.version);
    const queue = await json<{ items: AppCustomReviewItem[] }>(await send(admin, '/api/apps/reviews'));
    expect(
      queue.items.find((item) => item.app.id === p.appId && item.review.status === 'pending')?.previous?.version,
    ).toBe(live.version.version);
  });

  it('queries only a stored binding, trims fields, and executes only declared actions at the confirmed version', async () => {
    const p = await draft();
    const card = p.spec.pages[0]!.cards[1]!;
    if (card.kind !== 'custom') throw new Error('fixture');
    card.actions = [
      {
        id: 'rename',
        label: 'Rename',
        bindingId: 'rows',
        do: { type: 'set_fields', values: [], inputFieldIds: [p.primaryId] },
      },
    ];
    p.spec.roles[0]!.tables[0]!.access = 'edit';
    p.spec.roles[0]!.tables[0]!.fieldDefault = 'visible';
    const saved = await json<AppDraftView>(
      await send(owner, `/api/apps/${p.appId}/draft`, 'PUT', { spec: p.spec, draftRevision: 1 }),
    );
    expect(saved.errors).toEqual([]);
    const record = await json<{ record: { id: number; revision: number } }>(
      await send(owner, `/api/tables/tables/${p.tableId}/records`, 'POST', { values: { [p.primaryId]: 'First' } }),
      201,
    );
    const query = { pageId: 'home', cardId: 'timeline', bindingId: 'rows', draft: true };
    const rows = await json<AppCardQueryResult>(await send(owner, `/api/apps/${p.appId}/cards/query`, 'POST', query));
    expect(rows.kind).toBe('records');
    if (rows.kind !== 'records') throw new Error('fixture');
    expect(rows.records[0]?.values).toEqual({ [p.primaryId]: 'First' });
    expect(rows.records[0]?.actionIds).toEqual(['rename']);
    expect(
      (await send(owner, `/api/apps/${p.appId}/cards/query`, 'POST', { ...query, bindingId: 'invented' })).status,
    ).toBe(404);
    const action = {
      ...query,
      recordId: record.record.id,
      revision: record.record.revision,
      requestId: 'custom-action-1',
      actionId: 'rename',
      values: [{ fieldId: p.primaryId, value: 'Second' }],
    };
    expect((await send(owner, `/api/apps/${p.appId}/actions`, 'POST', { ...action, actionId: '$edit' })).status).toBe(
      403,
    );
    expect(
      (await send(owner, `/api/apps/${p.appId}/actions`, 'POST', { ...action, expectedSpecToken: 'draft:1' })).status,
    ).toBe(409);
    const view = await json<AppRuntimeView>(await send(owner, `/api/apps/${p.appId}?draft=1`));
    expect(view.specToken).toBe('draft:2');
    await json(
      await send(owner, `/api/apps/${p.appId}/actions`, 'POST', { ...action, expectedSpecToken: view.specToken }),
    );
    expect(
      await json<AppCardQueryResult>(await send(owner, `/api/apps/${p.appId}/cards/query`, 'POST', query)),
    ).toMatchObject({ kind: 'records', records: [{ values: { [p.primaryId]: 'Second' } }] });
  });
});
