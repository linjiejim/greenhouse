/**
 * Apps management over HTTP (Tables → Apps Phase 1, slice F1; real PostgreSQL,
 * rolled back per test): who may do what (D2 — builders manage drafts, only
 * the Base owner / super publishes and changes audiences, only a super
 * features), draft / audience CAS, the publish → restore → republish cycle
 * (D5), spec problems (saved with errors, refused at publish), the lists
 * (managed / shared with me / featured, group reach via `group_members`; a
 * shelf only lists what the person can open as a role, D3 / D4), pins, the
 * manager's runtime view (field `required`; the phone's `?cards=` ignored),
 * and the Base audit feed (app actions filed under the Base; reads never push
 * writes out).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type {
  AppAudiencesView,
  AppDraftView,
  AppListView,
  AppRuntimeView,
  AppSpec,
  AppSummary,
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
let member: UserRow;
let outsider: UserRow;
let groupCreator: UserRow;
let admin: UserRow;

function createHttpApp() {
  const byId = new Map([owner, builder, member, outsider, groupCreator, admin].map((user) => [user.id, user]));
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const user = byId.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  app.route('/api/tables', tablesRoutes);
  app.route('/api/apps', appRoutes);
  return app;
}

type App = ReturnType<typeof createHttpApp>;
let http: App;

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

/** A Base with one table; `builder` holds builder on it. */
async function base() {
  const created = await json<{
    base: { id: number };
    schema: { table: { id: number }; fields: Array<{ id: number }> };
  }>(await send(owner, '/api/tables/bases', 'POST', { name: 'Purchasing' }), 201);
  await json(
    await send(owner, `/api/tables/bases/${created.base.id}/members/${builder.id}`, 'PUT', { role: 'builder' }),
  );
  return { baseId: created.base.id, tableId: created.schema.table.id, primaryId: created.schema.fields[0]!.id };
}

function specFor(tableId: number, fieldId: number, roleName = 'Applicant'): AppSpec {
  return {
    version: 1,
    pages: [
      {
        id: 'mine',
        title: 'My requests',
        cards: [
          {
            id: 'list',
            kind: 'records',
            layout: { x: 0, y: 0, w: 12, h: 6 },
            source: { tableId },
            fieldIds: [fieldId],
          },
        ],
      },
      {
        id: 'review',
        title: 'Review',
        cards: [{ id: 'note', kind: 'text', layout: { x: 0, y: 0, w: 12, h: 2 }, markdown: 'Review here' }],
      },
    ],
    roles: [
      {
        key: 'applicant',
        name: roleName,
        pages: ['mine'],
        tables: [{ tableId, access: 'read', fields: [], fieldDefault: 'visible' }],
      },
      { key: 'approver', name: 'Approver', pages: 'all', tables: [] },
    ],
  };
}

async function createApp(user: UserRow, baseId: number, spec?: AppSpec) {
  return json<AppDraftView>(await send(user, '/api/apps', 'POST', { baseId, name: 'Requests', spec }), 201);
}

async function publish(appId: number, draftRevision: number, user: UserRow = owner) {
  return send(user, `/api/apps/${appId}/publish`, 'POST', { draftRevision, notes: 'Ship it' });
}

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  [owner, builder, member, outsider, groupCreator, admin] = await Promise.all(
    ['owner', 'builder', 'member', 'outsider', 'gcreator', 'admin'].map((who) =>
      createInternalTestUser(db, {
        email: `apps-api-${who}-${tag}@test.local`,
        nickname: `Apps ${who}`,
        role: who === 'admin' ? 'super' : 'team',
      }),
    ),
  );
  initializePlatformRuntime(db, [tablesRegistration]);
  http = createHttpApp();
});

afterEach(async () => {
  resetPlatformRuntimeForTests();
  await db.close();
  _resetProvider();
});

describe('who manages and who publishes (D2)', () => {
  it('lets a builder build the draft but only the owner publish and share', async () => {
    const { baseId, tableId, primaryId } = await base();
    const created = await createApp(builder, baseId);
    expect(created.app).toMatchObject({ status: 'draft', canManage: true, canPublish: false, ownerId: builder.id });
    expect(created.draftRevision).toBe(1);
    const appId = created.app.id;

    const saved = await json<AppDraftView>(
      await send(builder, `/api/apps/${appId}/draft`, 'PUT', { spec: specFor(tableId, primaryId), draftRevision: 1 }),
    );
    expect(saved).toMatchObject({ draftRevision: 2, errors: [] });

    const stale = await json<{ details: { currentRevision: number } }>(
      await send(builder, `/api/apps/${appId}/draft`, 'PUT', { spec: specFor(tableId, primaryId), draftRevision: 1 }),
      409,
    );
    expect(stale.details.currentRevision).toBe(2);

    expect((await publish(appId, 2, builder)).status).toBe(403);
    expect(
      (await send(builder, `/api/apps/${appId}/audiences`, 'PUT', { entries: [], audiencesRevision: 1 })).status,
    ).toBe(403);
    expect((await send(outsider, `/api/apps/${appId}/draft`)).status).toBe(404);
    expect((await publish(appId, 2, outsider)).status).toBe(404);

    expect((await publish(appId, 1)).status).toBe(409);
    const published = await json<{ app: AppSummary; version: { version: number; notes: string } }>(
      await publish(appId, 2),
    );
    expect(published.app).toMatchObject({ status: 'published', publishedVersion: 1, canPublish: true });
    expect(published.version).toMatchObject({ version: 1, notes: 'Ship it' });

    // A super publishes and shares on any Base.
    expect((await send(admin, `/api/apps/${appId}/audiences`)).status).toBe(200);
  });

  it('saves a draft with schema problems but refuses to publish it; a malformed spec is refused outright', async () => {
    const { baseId, tableId, primaryId } = await base();
    const { app } = await createApp(owner, baseId);
    const broken = specFor(tableId, 999_999_999);
    const saved = await json<AppDraftView>(
      await send(owner, `/api/apps/${app.id}/draft`, 'PUT', { spec: broken, draftRevision: 1 }),
    );
    expect(saved.draftRevision).toBe(2);
    expect(saved.errors).toContainEqual(expect.objectContaining({ pageId: 'mine', cardId: 'list' }));

    const refused = await json<{ error: string; details: { errors: unknown[] } }>(await publish(app.id, 2), 400);
    expect(refused.error).toBe('spec_invalid');
    expect(refused.details.errors.length).toBeGreaterThan(0);

    const malformed = { ...specFor(tableId, primaryId), pages: [{ id: 'Bad Id', title: 'x', cards: [] }] };
    const shape = await json<{ details: { errors: Array<{ path: string }> } }>(
      await send(owner, `/api/apps/${app.id}/draft`, 'PUT', { spec: malformed, draftRevision: 2 }),
      400,
    );
    expect(shape.details.errors.map((error) => error.path)).toContain('pages[0].id');
  });
});

describe('versions (D5)', () => {
  it('publishes v1 and v2, restores v1 into the draft and publishes it as v3', async () => {
    const { baseId, tableId, primaryId } = await base();
    const { app } = await createApp(owner, baseId, specFor(tableId, primaryId, 'Applicant'));
    await json(await publish(app.id, 1));
    await json(
      await send(owner, `/api/apps/${app.id}/draft`, 'PUT', {
        spec: specFor(tableId, primaryId, 'Requester'),
        draftRevision: 1,
      }),
    );
    await json(await publish(app.id, 2));

    const restored = await json<AppDraftView>(
      await send(owner, `/api/apps/${app.id}/versions/1/restore`, 'POST', { draftRevision: 2 }),
    );
    expect(restored.draftRevision).toBe(3);
    expect(restored.spec.roles[0]!.name).toBe('Applicant');
    expect((await send(owner, `/api/apps/${app.id}/versions/9/restore`, 'POST', { draftRevision: 3 })).status).toBe(
      404,
    );

    const third = await json<{ version: { version: number } }>(await publish(app.id, 3));
    expect(third.version.version).toBe(3);
    const versions = await json<{ versions: Array<{ version: number; publishedBy: { id: string } }> }>(
      await send(builder, `/api/apps/${app.id}/versions`),
    );
    expect(versions.versions.map((version) => version.version)).toEqual([3, 2, 1]);
    expect(versions.versions[0]!.publishedBy.id).toBe(owner.id);

    // The live view now shows v3's role name again.
    const view = await json<AppRuntimeView>(await send(owner, `/api/apps/${app.id}`));
    expect(view).toMatchObject({ version: 3, role: { key: '__manager__' } });
    expect(view.spec.roles.map((role) => role.name)).toEqual(['Applicant', 'Approver']);
  });
});

describe('audiences and what people see', () => {
  it('shares with a person, a group and everyone; only grantable groups; under CAS', async () => {
    const { baseId, tableId, primaryId } = await base();
    const { app } = await createApp(owner, baseId, specFor(tableId, primaryId));
    await json(await publish(app.id, 1));
    const hidden = await db.groups.create({ name: 'Not mine', created_by: groupCreator.id });
    const finance = await db.groups.create({ name: 'Finance', created_by: owner.id });
    await db.groups.addMembers(finance.id, [member.id], owner.id);

    const refused = await send(owner, `/api/apps/${app.id}/audiences`, 'PUT', {
      entries: [{ principal: { type: 'group', groupId: hidden.id }, roleKey: 'approver' }],
      audiencesRevision: 1,
    });
    expect(refused.status).toBe(404);
    const unknownRole = await send(owner, `/api/apps/${app.id}/audiences`, 'PUT', {
      entries: [{ principal: { type: 'team' }, roleKey: 'ghost' }],
      audiencesRevision: 1,
    });
    expect(unknownRole.status).toBe(400);

    const view = await json<AppAudiencesView>(
      await send(owner, `/api/apps/${app.id}/audiences`, 'PUT', {
        entries: [
          { principal: { type: 'group', groupId: finance.id }, roleKey: 'approver' },
          { principal: { type: 'user', userId: outsider.id }, roleKey: 'applicant' },
        ],
        audiencesRevision: 1,
      }),
    );
    expect(view.audiencesRevision).toBe(2);
    expect(view.entries).toEqual([
      expect.objectContaining({ principal: { type: 'group', groupId: finance.id }, name: 'Finance' }),
      expect.objectContaining({ principal: { type: 'user', userId: outsider.id }, roleKey: 'applicant' }),
    ]);
    expect(view.roles.map((role) => role.key)).toEqual(['applicant', 'approver']);
    expect(
      (await send(owner, `/api/apps/${app.id}/audiences`, 'PUT', { entries: [], audiencesRevision: 1 })).status,
    ).toBe(409);

    const listOf = async (user: UserRow) => json<AppListView>(await send(user, '/api/apps'));
    expect((await listOf(member)).shared.map((entry) => entry.id)).toContain(app.id);
    expect((await listOf(outsider)).shared.map((entry) => entry.id)).toContain(app.id);
    expect((await listOf(groupCreator)).shared.map((entry) => entry.id)).not.toContain(app.id);
    const ownerList = await listOf(owner);
    expect(ownerList.managed.map((entry) => entry.id)).toContain(app.id);
    expect(ownerList.shared.map((entry) => entry.id)).not.toContain(app.id);
  });

  it('features only through a super, and recommends only to the audience', async () => {
    const { baseId, tableId, primaryId } = await base();
    const { app } = await createApp(owner, baseId, specFor(tableId, primaryId));
    expect((await send(admin, `/api/apps/${app.id}/feature`, 'POST', { featured: true })).status).toBe(400);
    await json(await publish(app.id, 1));
    await json(
      await send(owner, `/api/apps/${app.id}/audiences`, 'PUT', {
        entries: [{ principal: { type: 'user', userId: member.id }, roleKey: 'applicant' }],
        audiencesRevision: 1,
      }),
    );
    expect((await send(owner, `/api/apps/${app.id}/feature`, 'POST', { featured: true })).status).toBe(403);
    const featured = await json<{ app: AppSummary }>(
      await send(admin, `/api/apps/${app.id}/feature`, 'POST', { featured: true }),
    );
    expect(featured.app.featured).toBe(true);
    expect((await json<AppListView>(await send(member, '/api/apps'))).featured.map((entry) => entry.id)).toContain(
      app.id,
    );
    expect(
      (await json<AppListView>(await send(outsider, '/api/apps'))).featured.map((entry) => entry.id),
    ).not.toContain(app.id);
  });

  it('pins only apps the caller can open, in their order', async () => {
    const { baseId, tableId, primaryId } = await base();
    const shared = await createApp(owner, baseId, specFor(tableId, primaryId));
    const draftOnly = await createApp(owner, baseId, specFor(tableId, primaryId));
    await json(await publish(shared.app.id, 1));
    await json(
      await send(owner, `/api/apps/${shared.app.id}/audiences`, 'PUT', {
        entries: [{ principal: { type: 'team' }, roleKey: 'applicant' }],
        audiencesRevision: 1,
      }),
    );
    expect((await send(member, '/api/apps/pins', 'PUT', { appIds: [draftOnly.app.id] })).status).toBe(404);
    const pinned = await json<{ apps: AppSummary[] }>(
      await send(member, '/api/apps/pins', 'PUT', { appIds: [shared.app.id] }),
    );
    expect(pinned.apps).toEqual([expect.objectContaining({ id: shared.app.id, pinned: true })]);
    const ownerPins = await json<{ apps: AppSummary[] }>(
      await send(owner, '/api/apps/pins', 'PUT', { appIds: [draftOnly.app.id, shared.app.id] }),
    );
    expect(ownerPins.apps.map((entry) => entry.id)).toEqual([draftOnly.app.id, shared.app.id]);
    expect((await json<{ apps: AppSummary[] }>(await send(member, '/api/apps/pins'))).apps.map((a) => a.id)).toEqual([
      shared.app.id,
    ]);
  });

  it('shelves an app for someone only while a role resolves for them (D3 / D4), as opening it does', async () => {
    const { baseId, tableId, primaryId } = await base();
    const { app } = await createApp(owner, baseId, specFor(tableId, primaryId));
    await json(await publish(app.id, 1));
    await json(
      await send(owner, `/api/apps/${app.id}/audiences`, 'PUT', {
        entries: [
          { principal: { type: 'user', userId: member.id }, roleKey: 'approver' },
          { principal: { type: 'team' }, roleKey: 'applicant' },
        ],
        audiencesRevision: 1,
      }),
    );
    await json(await send(admin, `/api/apps/${app.id}/feature`, 'POST', { featured: true }));
    const ids = (apps: AppSummary[]) => apps.map((entry) => entry.id);
    const listOf = async (user: UserRow) => json<AppListView>(await send(user, '/api/apps'));
    const before = await listOf(member);
    expect(ids(before.shared)).toContain(app.id);
    expect(ids(before.featured)).toContain(app.id);
    await json(await send(member, '/api/apps/pins', 'PUT', { appIds: [app.id] }));

    // v2 drops "approver": the member's own entry names a gone role and decides (no fall-through to the team).
    const v2 = specFor(tableId, primaryId);
    v2.roles = v2.roles.filter((role) => role.key !== 'approver');
    const saved = await json<AppDraftView>(
      await send(owner, `/api/apps/${app.id}/draft`, 'PUT', { spec: v2, draftRevision: 1 }),
    );
    expect(saved.errors).toEqual([]);
    await json(await publish(app.id, saved.draftRevision));

    expect((await send(member, `/api/apps/${app.id}`)).status).toBe(404);
    const after = await listOf(member);
    expect(ids(after.shared)).not.toContain(app.id);
    expect(ids(after.featured)).not.toContain(app.id);
    expect((await json<{ apps: AppSummary[] }>(await send(member, '/api/apps/pins'))).apps).toEqual([]);
    expect((await send(member, '/api/apps/pins', 'PUT', { appIds: [app.id] })).status).toBe(404);

    // The team entry still names a live role; managers keep the app whatever the audience says.
    const outsiderList = await listOf(outsider);
    expect(ids(outsiderList.shared)).toContain(app.id);
    expect(ids(outsiderList.featured)).toContain(app.id);
    const ownerList = await listOf(owner);
    expect(ids(ownerList.managed)).toContain(app.id);
    expect(ids(ownerList.featured)).toContain(app.id);
    // A super is no managed-list candidate on a Base they are not in, yet manages it: still on their shelf.
    const adminList = await listOf(admin);
    expect(adminList.shared.find((entry) => entry.id === app.id)).toMatchObject({ canManage: true });
  });
});

describe('opening, archiving and handing over', () => {
  it('gives managers the full view or a role preview, the audience its role, others 404', async () => {
    const { baseId, tableId, primaryId } = await base();
    const { app } = await createApp(owner, baseId, specFor(tableId, primaryId));

    const draft = await json<AppRuntimeView>(await send(builder, `/api/apps/${app.id}`));
    expect(draft).toMatchObject({ version: 0, draft: true, role: { key: '__manager__' }, issues: [] });
    expect(draft.tables).toEqual([
      expect.objectContaining({
        id: tableId,
        // The primary field is required: a form or create dialog can say so before the write refuses.
        fields: [expect.objectContaining({ id: primaryId, editable: true, required: true })],
      }),
    ]);

    await json(await publish(app.id, 1));
    await json(
      await send(owner, `/api/apps/${app.id}/audiences`, 'PUT', {
        entries: [{ principal: { type: 'user', userId: member.id }, roleKey: 'applicant' }],
        audiencesRevision: 1,
      }),
    );
    const preview = await json<AppRuntimeView>(await send(owner, `/api/apps/${app.id}?previewRole=applicant`));
    expect(preview.role).toEqual({ key: 'applicant', name: 'Applicant' });
    expect(preview.spec.pages.map((page) => page.id)).toEqual(['mine']);
    expect(preview.spec.roles.map((role) => role.key)).toEqual(['applicant']);
    expect(preview.tables[0]!.fields[0]).toMatchObject({ id: primaryId, editable: false, required: true });
    expect((await send(owner, `/api/apps/${app.id}?previewRole=ghost`)).status).toBe(400);

    // The audience opens the live version as its role (slice G); everyone else gets 404.
    const viewer = await json<AppRuntimeView>(await send(member, `/api/apps/${app.id}`));
    expect(viewer.role).toEqual({ key: 'applicant', name: 'Applicant' });
    expect(viewer.app).toMatchObject({ canManage: false, canPublish: false });
    expect(viewer.tables[0]!.fields[0]).toMatchObject({ id: primaryId, required: true });
    expect((await send(outsider, `/api/apps/${app.id}`)).status).toBe(404);
  });

  it('accepts the phone’s ?cards= list on GET /api/apps/:id and ignores it', async () => {
    const { baseId, tableId, primaryId } = await base();
    const { app } = await createApp(owner, baseId, specFor(tableId, primaryId));
    await json(await publish(app.id, 1));
    await json(
      await send(owner, `/api/apps/${app.id}/audiences`, 'PUT', {
        entries: [{ principal: { type: 'user', userId: member.id }, roleKey: 'applicant' }],
        audiencesRevision: 1,
      }),
    );
    // iOS sends the card kinds it renders (MOBILE_APP_CARDS); the server answers the same view.
    const cards = 'records,kanban,calendar,gallery,form,kpi,chart,pivot,text,buttons';
    const plain = await json<AppRuntimeView>(await send(member, `/api/apps/${app.id}`));
    expect(await json<AppRuntimeView>(await send(member, `/api/apps/${app.id}?cards=${cards}`))).toEqual(plain);
    expect(await json<AppRuntimeView>(await send(member, `/api/apps/${app.id}?cards=`))).toEqual(plain);
    const managerPlain = await json<AppRuntimeView>(await send(owner, `/api/apps/${app.id}?draft=1`));
    expect(await json<AppRuntimeView>(await send(owner, `/api/apps/${app.id}?draft=1&cards=${cards}`))).toEqual(
      managerPlain,
    );
    expect((await send(outsider, `/api/apps/${app.id}?cards=${cards}`)).status).toBe(404);
  });

  it('archives a published app only as the owner, and hands an app only to a Base manager', async () => {
    const { baseId, tableId, primaryId } = await base();
    const { app } = await createApp(builder, baseId, specFor(tableId, primaryId));
    await json(await publish(app.id, 1));

    expect((await send(builder, `/api/apps/${app.id}/transfer`, 'POST', { userId: member.id })).status).toBe(400);
    const handed = await json<{ app: AppSummary }>(
      await send(builder, `/api/apps/${app.id}/transfer`, 'POST', { userId: owner.id }),
    );
    expect(handed.app.ownerId).toBe(owner.id);
    // No longer the app owner, and not the Base owner: cannot hand it on.
    expect((await send(builder, `/api/apps/${app.id}/transfer`, 'POST', { userId: builder.id })).status).toBe(403);

    expect((await send(builder, `/api/apps/${app.id}/archive`, 'POST')).status).toBe(403);
    const archived = await json<{ app: AppSummary }>(await send(owner, `/api/apps/${app.id}/archive`, 'POST'));
    expect(archived.app.status).toBe('archived');
    expect((await json<AppListView>(await send(owner, '/api/apps'))).managed.map((entry) => entry.id)).not.toContain(
      app.id,
    );

    // A never-published draft is the builder's to clean up.
    const draft = await createApp(builder, baseId);
    expect((await send(builder, `/api/apps/${draft.app.id}/archive`, 'POST')).status).toBe(200);
  });
});

describe('the Base audit feed', () => {
  it('files app actions under their Base, and 200 app reads do not push a write out', async () => {
    const { baseId, tableId, primaryId } = await base();
    const { app } = await createApp(owner, baseId, specFor(tableId, primaryId));
    await json(await publish(app.id, 1));
    for (let i = 0; i < 200; i += 1) {
      const response = await send(owner, `/api/apps/${app.id}/versions`);
      expect(response.status).toBe(200);
    }

    const audit = await json<{
      events: Array<{ action_id: string; entity_id: string; record_id: string; scope_type: string; scope_id: string }>;
    }>(await send(owner, `/api/tables/bases/${baseId}/audit?limit=100`));
    const actions = audit.events.map((event) => event.action_id);
    expect(actions).toEqual(expect.arrayContaining(['publishApp', 'createApp', 'manageMembers']));
    expect(actions).not.toContain('listAppVersions');
    expect(audit.events).toContainEqual(
      expect.objectContaining({
        action_id: 'publishApp',
        entity_id: 'app',
        record_id: String(app.id),
        scope_type: 'base',
        scope_id: String(baseId),
      }),
    );

    // The reads were filed under the Base too (usage reads them back by app) — just not listed.
    const reads = await db.platform.listAuditEventsByScope({
      orgId: 'default',
      appId: 'tables',
      scopeType: 'base',
      scopeId: String(baseId),
      actionIds: ['listAppVersions'],
      limit: 500,
    });
    expect(reads).toHaveLength(200);
    // 200 requests: room for a loaded full run.
  }, 30_000);
});
