import { defineApp } from '@greenhouse/api/extension-kit';
import { registerDiscriminators } from '@greenhouse/types/discriminators';
import { sql } from 'drizzle-orm';
import { defineExtension } from '../../../../apps/api/src/extensions/define.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authMiddleware } from '../../../../apps/api/src/auth/middleware.js';
import { createAccessToken } from '../../../../apps/api/src/auth/token.js';
import extUiRoutes from '../../../../apps/api/src/routes/ext-ui.js';
import { Hono } from 'hono';
import { initDatabase, _resetProvider, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { EXTENSIONS } from '../../../../apps/api/src/extensions/index.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../../../apps/api/src/platform/runtime.js';
import type { AppEnv } from '../../../../apps/api/src/app-env.js';
import { createInternalTestUser } from '../../../../tests/helpers/internal-user.js';
import { stationManifest } from '../../../../apps/api/src/extensions/station-manifest.js';
import { createActivityRoutes } from '../../../../apps/api/src/routes/activity.js';
import { getPlatformRuntime } from '../../../../apps/api/src/platform/runtime.js';
import { humanActor } from '../../../../apps/api/src/platform/actor.js';

let db: DatabaseProvider, alice: UserRow, bob: UserRow, admin: UserRow;
let extraRoutes: NonNullable<import('../../../../apps/api/src/extensions/define.js').GreenhouseExtension['routes']> =
  [];
const extension = EXTENSIONS.find((ext) => ext.id === 'example')!;
function app(user: UserRow) {
  const app = new Hono<AppEnv>().use('*', async (c, next) => {
    c.set('user', { id: user.id, role: user.role });
    await next();
  });
  for (const route of [...(extension.routes ?? []), ...extraRoutes]) app.route(route.path, route.app);
  app.route('/api/activity', createActivityRoutes());
  return app;
}
const base = '/api/ext/example/entities/note';
function json(method: string, body: unknown) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
beforeEach(async () => {
  extraRoutes = [];
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  initializePlatformRuntime(
    db,
    EXTENSIONS.flatMap((ext) => ext.applications ?? []),
  );
  alice = await createInternalTestUser(db, { email: `sdk-alice-${crypto.randomUUID()}@test.local` });
  bob = await createInternalTestUser(db, { email: `sdk-bob-${crypto.randomUUID()}@test.local` });
  admin = await createInternalTestUser(db, { email: `sdk-super-${crypto.randomUUID()}@test.local`, role: 'super' });
  for (const user of [alice, bob])
    await db.userFeatures.upsert({ user_id: user.id, feature: 'example', enabled: true });
});
afterEach(async () => {
  resetPlatformRuntimeForTests();
  await db.close();
  _resetProvider();
});
describe('data plugin REST and station manifest', () => {
  it.each(['team', 'super'])('rejects whole-record and forbidden writes atomically for %s', async (role) => {
    const user = role === 'team' ? alice : admin;
    const row = await (await app(user).request(base, json('POST', { body: 'Original' }))).json();
    expect(row.userId).toBe(user.id);
    for (const data of [
      { userId: bob.id },
      { createdAt: row.createdAt },
      { id: row.id + 1 },
      { unknown: true },
      { constructor: 'bad' },
      { userId: row.userId, createdAt: row.createdAt },
    ]) {
      for (const [method, url] of [
        ['POST', base],
        ['PATCH', `${base}/${row.id}`],
        ['PUT', `${base}/${row.id}`],
      ]) {
        const response = await app(user).request(url, json(method, { body: 'Edited', ...data }));
        expect(response.status).toBe(400);
        const error = (await response.json()).error;
        for (const key of Object.keys(data)) expect(error).toContain(key);
        expect(await (await app(user).request(`${base}/${row.id}`)).json()).toEqual(row);
      }
    }
    const response = await app(user).request(`${base}/${row.id}`, json('PATCH', { body: 'Edited' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...row, body: 'Edited' });
    expect(await (await app(user).request(`${base}/${row.id}`)).json()).toEqual({ ...row, body: 'Edited' });
  });
  it('enforces the same input contract for mutation tools and direct runtime dispatch', async () => {
    const tool = extension.tools!.find((t) => t.meta.id === 'example_mutation')!.createLazy!({
      db,
      userId: alice.id,
      userRole: alice.role,
    }) as any;
    const row = await tool.execute({ entity: 'note', action: 'create', data: { body: 'Original' } });
    const runtime = getPlatformRuntime(),
      actor = humanActor(alice);
    for (const action of ['create', 'update'] as const) {
      for (const data of [
        { id: 77 },
        { userId: bob.id },
        { createdAt: '2026-10-26 22:50:11.703622+00' },
        { unknown: 1 },
      ]) {
        const operation = { action, id: String(row.id), data: { body: 'Denied', ...data } };
        expect(await tool.execute({ entity: 'note', ...operation })).toMatchObject({
          error: expect.stringContaining(Object.keys(data)[0]),
        });
        expect(
          await runtime.dispatch({
            actor,
            appId: 'example',
            actionId: action === 'create' ? 'noteCreate' : 'noteUpdate',
            payload: operation,
          }),
        ).toMatchObject({ ok: false, code: 'INVALID_INPUT', message: expect.stringContaining(Object.keys(data)[0]) });
      }
    }
    for (const data of [null, [], 'bad']) {
      expect(
        await runtime.dispatch({ actor, appId: 'example', actionId: 'noteUpdate', payload: { id: row.id, data } }),
      ).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    }
    expect(
      await tool.execute({ entity: 'note', action: 'update', id: row.id, data: { body: 'Tool edit' } }),
    ).toMatchObject({ id: row.id, body: 'Tool edit', userId: alice.id });
    expect(
      await runtime.dispatch({
        actor,
        appId: 'example',
        actionId: 'noteUpdate',
        payload: { id: row.id, data: { body: 'Runtime edit' } },
      }),
    ).toMatchObject({ ok: true, data: { id: row.id, body: 'Runtime edit', userId: alice.id } });
    expect(await (await app(alice).request(`${base}/${row.id}`)).json()).toEqual({ ...row, body: 'Runtime edit' });
  });
  it('uses the CRUD protocol with filters, sort, paging and member ownership', async () => {
    for (const body of ['Beta', 'Alpha', 'Gamma'])
      expect((await app(alice).request(base, json('POST', { body }))).status).toBe(201);
    await app(bob).request(base, json('POST', { body: 'Other member' }));
    const res = await app(alice).request(
      `${base}/list`,
      json('POST', {
        filter: [{ key: 'body', method: 'ilike', value: ['a'] }],
        sort: [{ key: 'body', order: 'asc' }],
        skip: 1,
        limit: 1,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ items: [{ body: 'Beta', userId: alice.id }], total: 3 });
    const all = await (await app(alice).request(base)).json();
    expect(all.total).toBe(3);
    const id = all.items[0].id;
    expect((await app(bob).request(`${base}/${id}`)).status).toBe(404);
    expect((await app(bob).request(`${base}/${id}`, json('PATCH', { body: 'stolen' }))).status).toBe(404);
    expect((await app(alice).request(`${base}/${id}`, json('PATCH', { body: 'Updated' }))).status).toBe(200);
    expect((await app(alice).request(`${base}/${id}/peek`)).status).toBe(200);
    expect((await app(alice).request(`${base}/${id}`, { method: 'DELETE' })).status).toBe(200);
  });
  it('rejects bad filters, malformed JSON and disabled actions and features', async () => {
    expect(
      (
        await app(alice).request(
          `${base}/list`,
          json('POST', { filter: [{ key: 'password', method: 'eq', value: ['x'] }] }),
        )
      ).status,
    ).toBe(400);
    expect((await app(alice).request(`${base}?filter=not-json`)).status).toBe(400);
    expect((await app(alice).request(base, json('POST', { body: 123 }))).status).toBe(400);
    const team = (await db.platform.getRoleByCode('default', 'team'))!;
    await db.platform.replaceRoleCapabilities(
      team.id,
      (await db.platform.listRoleCapabilities([team.id]))
        .map((r) => r.capability)
        .filter((c) => c !== 'example.note.create'),
    );
    expect((await app(alice).request(base, json('POST', { body: 'Denied' }))).status).toBe(403);
    await db.userFeatures.upsert({ user_id: alice.id, feature: 'example', enabled: false });
    expect((await app(alice).request(base)).status).toBe(403);
  });
  it('runs generated tools through the real runtime, records audit/activity, and keeps scoped search/export', async () => {
    const ctx = { db, userId: alice.id, userRole: alice.role };
    const mutation = extension.tools!.find((t) => t.meta.id === 'example_mutation')!.createLazy!(ctx) as any;
    const note = await mutation.execute({ entity: 'note', action: 'create', data: { body: 'Runtime note' } });
    expect(note.body).toBe('Runtime note');
    const query = extension.tools!.find((t) => t.meta.id === 'example_query')!.createLazy!(ctx) as any;
    expect(await query.execute({ entity: 'note', action: 'search', query: 'Runtime' })).toMatchObject({ total: 1 });
    const audit = await db.executeRaw(
      (await import('drizzle-orm'))
        .sql`SELECT * FROM audit_events WHERE app_id = 'example' AND action_id = 'noteCreate' AND on_behalf_of_user_id = ${alice.id}`,
    );
    expect(audit).toHaveLength(1);
    await app(alice).request(base, json('POST', { body: 'REST note' }));
    const activity = await (await app(alice).request('/api/activity')).json();
    expect(activity.items.some((item: any) => item.module === 'example')).toBe(true);
    const source = extension.exportSources!.find((e) => e.type === 'example_note')!;
    const exported = await source.load({ type: source.type }, { userId: alice.id, sessionId: 'test' }, db);
    expect(exported.rows).toHaveLength(2);
    expect(exported.rows.some((row) => row.body === 'Runtime note')).toBe(true);
  });
  it('cuts v2 surfaces/actions to the member and keeps v1 fields', async () => {
    const member = await stationManifest(db, {
      id: alice.id,
      role: alice.role,
    });
    const plugin = member.plugins.find((p) => p.id === 'example')!;
    expect(member.core.client_api).toBe(4);
    expect(member.manifest_version).toBe(2);
    expect(plugin.entities[0].actions).toEqual(['read', 'create', 'update', 'delete', 'export']);
    expect(plugin.entities[0].fields.filter((f) => f.writable).map((f) => f.key)).toEqual(['body']);
    expect(plugin.pages.some((p) => p.kind === 'settings-form')).toBe(false);
    expect(member.extensions.some((p) => p.id === 'example')).toBe(true);
    expect(member.entityKinds.some((k) => k.kind === 'ext:example:note')).toBe(true);
    const superManifest = await stationManifest(db, {
      id: admin.id,
      role: admin.role,
    });
    expect(superManifest.plugins.find((p) => p.id === 'example')!.pages.some((p) => p.kind === 'settings-form')).toBe(
      true,
    );
    expect(
      superManifest.plugins
        .find((p) => p.id === 'example')!
        .entities[0].fields.filter((f) => f.writable)
        .map((f) => f.key),
    ).toEqual(['body']);
    const team = (await db.platform.getRoleByCode('default', 'team'))!;
    await db.platform.replaceRoleCapabilities(
      team.id,
      (await db.platform.listRoleCapabilities([team.id]))
        .map((r) => r.capability)
        .filter((c) => !c.startsWith('example.')),
    );
    expect(
      (await stationManifest(db, { id: alice.id, role: alice.role })).plugins.some((p) => p.id === 'example'),
    ).toBe(false);
    expect((await stationManifest(db, { id: admin.id, role: admin.role }, [])).plugins).toEqual([]);
  });
});

it('enforces collaborating scopes, classification, every write action and the writes-only audit policy', async () => {
  await db.executeRaw(
    sql`CREATE TABLE ext_sdk2_collab (id text PRIMARY KEY, title text, members jsonb, secret text, hidden text)`,
  );
  const ext = defineExtension({
    id: 'collab',
    name: 'Collaborating',
    dataSources: [
      {
        app: defineApp({
          id: 'collab',
          title: 'Collaborating',
          version: '1.0.0',
          modules: { note: { title: 'Notes' } },
          actions: {},
          entities: {
            note: {
              title: 'Note',
              module: 'note',
              table: 'ext_sdk2_collab',
              accessScopes: ['collaborating'],
              fields: {
                id: { kind: 'text', title: 'ID' },
                title: { kind: 'text', title: 'Title' },
                members: { kind: 'users', title: 'Members' },
                secret: { kind: 'text', title: 'Secret', classification: 'confidential', filterable: true },
                hidden: { kind: 'text', title: 'Hidden', classification: 'restricted' },
              },
            },
          },
        }),
        entities: {
          note: {
            actions: { read: 'team', export: 'team', create: 'super', update: 'super', delete: 'super' },
            memberField: 'members',
            audit: 'writes',
            peek: { title: 'title' },
          },
        },
      },
    ],
  });
  registerDiscriminators({ auditApps: ['collab'] });
  const registration = ext.applications![0];
  initializePlatformRuntime(db, [...EXTENSIONS.flatMap((e) => e.applications ?? []), registration]);
  const team = (await db.platform.getRoleByCode('default', 'team'))!;
  await db.platform.replaceRoleCapabilities(team.id, [
    ...(await db.platform.listRoleCapabilities([team.id])).map((r) => r.capability),
    ...registration.teamCapabilities!,
  ]);
  await db.platform.upsertRoleEntityPolicy(team.id, {
    app_id: 'collab',
    module_id: 'note',
    entity_id: 'note',
    scopes: [{ kind: 'collaborating' }],
    field_policies: registration.teamFieldPolicies!.note,
  });
  await db.executeRaw(
    sql`INSERT INTO ext_sdk2_collab VALUES ('shared', 'Shared note', ${JSON.stringify([alice.id])}::jsonb, 'private', 'hidden')`,
  );
  extraRoutes = ext.routes!;
  const url = '/api/ext/collab/entities/note';
  const response = await app(alice).request(url);
  expect(await response.json()).toMatchObject({ items: [{ id: 'shared', secret: '***' }], total: 1 });
  expect(JSON.stringify(await (await app(alice).request(url)).json())).not.toContain('hidden');
  expect(await (await app(bob).request(url)).json()).toMatchObject({ items: [], total: 0 });
  expect((await app(bob).request(`${url}/shared`)).status).toBe(404);
  const audit = await db.executeRaw(sql`SELECT * FROM audit_events WHERE app_id = 'collab' AND result = 'success'`);
  expect(audit).toHaveLength(0);
  for (const [method, path, body] of [
    ['POST', url, { title: 'No' }],
    ['PATCH', `${url}/shared`, { title: 'No' }],
    ['DELETE', `${url}/shared`, {}],
  ] as const)
    expect((await app(alice).request(path, json(method, body))).status).toBe(403);
  expect(
    (
      await app(alice).request(
        `${url}/list`,
        json('POST', { filter: [{ key: 'secret', method: 'eq', value: ['private'] }] }),
      )
    ).status,
  ).toBe(403);
  const exported = await ext.exportSources![0].load({}, { userId: alice.id, sessionId: 'test' }, db);
  expect(exported.rows).toEqual([{ id: 'shared', title: 'Shared note', members: [alice.id] }]);
});

it('applies SDK 2 field policies to the legacy notes routes, resources, writes and export too', async () => {
  const { getExtensionServices } = await import('@greenhouse/db');
  const services = getExtensionServices<import('../service.js').ExampleServices>(db, 'example');
  const note = await services.notes.add(alice.id, 'FIELD-POLICY-SECRET');
  const team = (await db.platform.getRoleByCode('default', 'team'))!;
  const snapshot = await db.platform.getEntityPolicySnapshot({ userId: alice.id, appId: 'example', entityId: 'note' });
  await db.platform.upsertRoleEntityPolicy(team.id, {
    app_id: 'example',
    module_id: 'note',
    entity_id: 'note',
    scopes: [{ kind: 'own' }],
    field_policies: { ...snapshot.rolePolicies[0].fields, body: { read: 'masked', write: false, export: false } },
  });
  const denied = await app(alice).request(`${base}/${note.id}`, json('PATCH', { body: 'Denied' }));
  expect(denied.status).toBe(400);
  expect((await denied.json()).error).toContain('body');
  const manifest = await stationManifest(db, { id: alice.id, role: alice.role });
  expect(
    manifest.plugins.find((p) => p.id === 'example')!.entities[0].fields.find((f) => f.key === 'body')!.writable,
  ).toBe(false);
  const response = await app(alice).request('/api/ext/example/notes');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ notes: [{ id: note.id, body: '***' }] });
  const mutation = extension.tools!.find((tool) => tool.meta.id === 'example_notes_mutation')!.createLazy!({
    db,
    userId: alice.id,
    userRole: 'team',
  }) as any;
  await expect(mutation.execute({ action: 'notes.add', body: 'DENIED' })).rejects.toThrow('Note policy denied');
  const exported = await extension
    .exportSources!.find((source) => source.type === 'example_notes')!
    .load({}, { userId: alice.id, sessionId: 'test' }, db);
  expect(exported.rows[0]).not.toHaveProperty('body');
  const resource = await extension.mcpResources![0].read(`greenhouse://ext/example/note/${note.id}`, {
    db,
    userId: alice.id,
  } as never);
  expect(resource).toMatchObject({ text: '***' });
});

it('requires explicit scope-field opt-in, a field grant and an action capability; create always stamps the caller', async () => {
  const source = extension.dataSources![0];
  const assignable = defineExtension({
    id: 'example',
    name: 'Assignable fixture',
    dataSources: [
      {
        ...source,
        app: {
          ...source.app,
          entities: {
            note: {
              ...source.app.entities.note,
              accessScopes: ['all'],
              fields: { ...source.app.entities.note.fields, userId: { kind: 'user', title: 'Owner', writable: true } },
            },
          },
        },
      },
    ],
  });
  initializePlatformRuntime(
    db,
    EXTENSIONS.flatMap((e) => (e.id === 'example' ? assignable.applications! : (e.applications ?? []))),
  );
  extraRoutes = [];
  const routes = new Hono<AppEnv>().use('*', async (c, next) => {
    c.set('user', { id: alice.id, role: alice.role });
    await next();
  });
  for (const route of assignable.routes!) routes.route(route.path, route.app);
  const team = (await db.platform.getRoleByCode('default', 'team'))!;
  const fields = assignable.applications![0].teamFieldPolicies!.note;
  await db.platform.upsertRoleEntityPolicy(team.id, {
    app_id: 'example',
    module_id: 'note',
    entity_id: 'note',
    scopes: [{ kind: 'all' }],
    field_policies: fields,
  });
  const created = await routes.request(base, json('POST', { body: 'Assigned', userId: bob.id }));
  expect(created.status).toBe(201);
  const row = await created.json();
  expect(row.userId).toBe(alice.id);
  expect((await routes.request(`${base}/${row.id}`, json('PATCH', { userId: bob.id }))).status).toBe(200);
  expect(await (await routes.request(`${base}/${row.id}`)).json()).toMatchObject({ userId: bob.id });
  await db.platform.upsertRoleEntityPolicy(team.id, {
    app_id: 'example',
    module_id: 'note',
    entity_id: 'note',
    scopes: [{ kind: 'all' }],
    field_policies: { ...fields, userId: { read: 'full', write: false, export: true } },
  });
  expect((await routes.request(`${base}/${row.id}`, json('PATCH', { userId: alice.id }))).status).toBe(400);
  const manifest = await stationManifest(db, { id: alice.id, role: alice.role }, [assignable]);
  expect(manifest.plugins[0].entities[0].fields.find((f) => f.key === 'userId')!.writable).toBe(false);
  await db.platform.replaceRoleCapabilities(
    team.id,
    (await db.platform.listRoleCapabilities([team.id]))
      .map((r) => r.capability)
      .filter((c) => !['example.note.create', 'example.note.update'].includes(c)),
  );
  expect((await routes.request(`${base}/${row.id}`, json('PATCH', { body: 'Denied' }))).status).toBe(403);
  const readonly = await stationManifest(db, { id: alice.id, role: alice.role }, [assignable]);
  expect(readonly.plugins[0].entities[0].fields.every((f) => !f.writable)).toBe(true);
});

it('provides working table-backed registry handlers and rejects a mutation disguised as a read', async () => {
  const { getPlatformRuntime } = await import('../../../../apps/api/src/platform/runtime.js');
  const { humanActor } = await import('../../../../apps/api/src/platform/actor.js');
  const runtime = getPlatformRuntime(),
    actor = humanActor(alice);
  const created = await runtime.dispatch({
    actor,
    appId: 'example',
    actionId: 'noteCreate',
    payload: { data: { body: 'Direct application handler' } },
  });
  expect(created).toMatchObject({ ok: true, data: { body: 'Direct application handler', userId: alice.id } });
  const id = (created as { ok: true; data: { id: number } }).data.id;
  const attempted = await runtime.dispatch({
    actor,
    appId: 'example',
    actionId: 'noteRead',
    payload: { action: 'delete', id },
  });
  expect(attempted).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  expect((await app(alice).request(`${base}/${id}`)).status).toBe(200);
  expect(
    await db.executeRaw(
      sql`SELECT * FROM audit_events WHERE app_id = 'example' AND action_id = 'noteCreate' AND actor_id = ${alice.id}`,
    ),
  ).toHaveLength(1);
});

it('issues embed credentials only for visible plugins and preserves row ownership', async () => {
  vi.stubEnv('TOKEN_SIGNING_KEY', '99'.repeat(32));
  try {
    const shell = new Hono<AppEnv>().use('*', authMiddleware).route('/api/ext-ui', extUiRoutes);
    for (const route of extension.routes ?? []) shell.route(route.path, route.app);
    const full = {
      Authorization: `Bearer ${createAccessToken(alice.id, 'team', alice.auth_version)}`,
      'Content-Type': 'application/json',
    };
    const issued = await shell.request('/api/ext-ui/token', {
      method: 'POST',
      headers: full,
      body: '{"plugin":"example"}',
    });
    expect(issued.status).toBe(200);
    const headers = { Authorization: `Bearer ${(await issued.json()).token}` };
    const own = await (await app(alice).request(base, json('POST', { body: 'Mine' }))).json();
    const other = await (await app(bob).request(base, json('POST', { body: 'Other member' }))).json();
    expect((await shell.request(`${base}/${own.id}`, { headers })).status).toBe(200);
    expect((await shell.request(`${base}/${other.id}`, { headers })).status).toBe(404);
    await db.userFeatures.upsert({ user_id: alice.id, feature: 'example', enabled: false });
    expect((await shell.request(base, { headers })).status).toBe(403);
    expect(
      (await shell.request('/api/ext-ui/token', { method: 'POST', headers: full, body: '{"plugin":"example"}' }))
        .status,
    ).toBe(403);
  } finally {
    vi.unstubAllEnvs();
  }
});
