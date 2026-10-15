import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import {
  applyExtensionMigrations,
  auditEvents,
  usageEvents,
  extensionMigrations,
  getDb,
  transaction,
} from '@greenhouse/db';
import { createTestApp } from '../../testing.js';
import { exampleExtension } from '../example/index.js';
import { exampleService } from '../example/service.js';
import { registerExtensionAdapters } from '../host.js';
import { scriptedModel, text, toolCall } from '../../engine/__tests__/model.js';

const migrate = () => applyExtensionMigrations([{ extensionId: 'example', dir: exampleExtension.migrations!.dir }]);
registerExtensionAdapters([exampleExtension]);

it('applies the independent migration lane once and refuses checksum drift atomically', async () => {
  expect(await migrate()).toEqual(['example/0001_notes.sql']);
  expect(await migrate()).toEqual([]);
  await getDb()
    .update(extensionMigrations)
    .set({ checksum: 'changed' })
    .where(eq(extensionMigrations.extensionId, 'example'));
  await expect(transaction(async () => migrate())).rejects.toThrow('changed');
});

it('rolls back all extension DDL and tracking when any statement fails', async () => {
  await expect(
    applyExtensionMigrations([{ extensionId: 'broken', dir: fileURLToPath(new URL('./migrations', import.meta.url)) }]),
  ).rejects.toThrow();
  const rows = await getDb().execute(sql`select to_regclass('ext_example_should_roll_back') as name`);
  expect(rows[0]?.name).toBeNull();
  expect(await getDb().select().from(extensionMigrations).where(eq(extensionMigrations.extensionId, 'broken'))).toEqual(
    [],
  );
});

it('mounts only enabled routes, authenticates them, enforces settings ownership and admin access in services', async () => {
  await migrate();
  const app = createTestApp({}, { extensions: [exampleExtension] });
  const owner = await app.member();
  const other = await app.member();
  const admin = await app.member('admin');
  const path = '/api/ext/example';
  expect((await app.call('GET', `${path}/notes`)).status).toBe(401);
  expect((await createTestApp().call('GET', `${path}/notes`, { token: owner.token })).status).toBe(404);
  const note = await app.call('POST', `${path}/notes`, { token: owner.token, body: { title: 'Private memo' } });
  expect(note.status).toBe(201);
  expect((await app.call('GET', `${path}/notes/${note.body.id}`, { token: other.token })).status).toBe(404);
  expect((await app.call('GET', `${path}/notes`, { token: other.token })).body.items).toEqual([]);
  await app.call('PATCH', `${path}/settings`, { token: owner.token, body: { label: 'Mine' } });
  expect((await app.call('GET', `${path}/settings`, { token: other.token })).body.label).toBe('Example');
  expect(
    (await app.call('PATCH', `${path}/admin/settings`, { token: owner.token, body: { label: 'Forbidden' } })).status,
  ).toBe(403);
  await expect(exampleService.saveSettings(owner.id, true, 'Forbidden')).rejects.toMatchObject({ code: 'forbidden' });
  expect(
    (await app.call('PATCH', `${path}/admin/settings`, { token: admin.token, body: { label: 'Workspace' } })).status,
  ).toBe(200);
  expect(
    (await getDb().select().from(auditEvents).where(eq(auditEvents.action, 'extension.example.settings')))[0],
  ).toMatchObject({ actorId: admin.id, summary: 'label' });
  expect((await app.call('GET', '/api/extensions', { token: owner.token })).body.items[0]).toMatchObject({
    pages: ['notes'],
    settings_sections: ['preferences'],
    admin_sections: [],
  });
  const search = await app.call('GET', '/api/search?q=Private&kinds=extensions', { token: owner.token });
  expect(search.body.items[0]).toMatchObject({
    kind: 'extensions',
    title: 'Private memo',
    href: `#/ext/example/notes/${note.body.id}`,
  });
  expect((await app.call('GET', '/api/search?q=Private&kinds=extensions', { token: other.token })).body.items).toEqual(
    [],
  );
  const doc = await app.call('POST', '/api/knowledge/docs', {
    token: owner.token,
    body: { title: 'Private doc', space: 'personal' },
  });
  expect(doc.status).toBe(201);
  expect((await app.call('GET', `${path}/docs/${doc.body.id}/panel`, { token: other.token })).status).toBe(404);
  expect((await app.call('GET', `${path}/docs/${doc.body.id}/panel`, { token: owner.token })).status).toBe(200);
});

it('puts extension writes through the same approval executor as core tools', async () => {
  await migrate();
  const model = scriptedModel([
    toolCall('ext_example_notes', { action: 'create', title: 'Approved memo' }),
    text('Saved.'),
  ]);
  const app = createTestApp({}, { extensions: [exampleExtension], languageModel: model.languageModel });
  const owner = await app.member();
  const main = (await app.call('GET', '/api/conversations', { token: owner.token })).body.items[0];
  await app.call('POST', `/api/conversations/${main.id}/messages`, {
    token: owner.token,
    body: { content: 'Save my memo' },
  });
  await app.services.engine.idle();
  expect((await exampleService.list(owner.id, { limit: 20 })).items).toEqual([]);
  const requests = await app.call('GET', '/api/requests', { token: owner.token });
  expect(requests.body.items).toHaveLength(1);
  const decision = await app.call('POST', `/api/requests/${requests.body.items[0].id}/approve`, {
    token: owner.token,
  });
  expect(decision.status).toBe(200);
  await app.services.engine.idle();
  expect((await exampleService.list(owner.id, { limit: 20 })).items[0]?.title).toBe('Approved memo');
});

describe('extension provider adapters', () => {
  it('uses the configured pinned fetch, unified usage and budget boundary', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify([{ title: 'Result', url: 'https://example.com/result', snippet: 'Found' }]), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const app = createTestApp({}, { extensions: [exampleExtension], fetch: fetch as typeof globalThis.fetch });
    const admin = await app.member('admin');
    const created = await app.call('POST', '/api/admin/providers', {
      token: admin.token,
      body: {
        capability: 'search',
        kind: 'example-search',
        name: 'Example',
        config: { baseUrl: 'https://example.com/search' },
        secrets: {},
      },
    });
    expect(created.status).toBe(201);
    const provider = await app.services.providers.byId('search', created.body.id, { memberId: admin.id });
    expect(await provider!.client.search('query')).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await app.call('GET', '/api/me/usage', { token: admin.token })).body.totals.requests).toBe(1);
    const agent = (await app.call('POST', '/api/agents', { token: admin.token, body: { name: 'Search Agent' } })).body;
    await app.call('PUT', `/api/agents/${agent.id}/publication`, {
      token: admin.token,
      body: { audience: [{ type: 'workspace' }] },
    });
    await app.call('PUT', `/api/agents/${agent.id}/budgets`, {
      token: admin.token,
      body: { unit: 'usd_micros', monthly_limit: 1 },
    });
    await getDb().insert(usageEvents).values({
      capability: 'search',
      providerId: created.body.id,
      source: 'workspace',
      memberId: admin.id,
      agentId: agent.id,
      costMicros: 1,
    });
    const budgeted = await app.services.providers.byId('search', created.body.id, {
      memberId: admin.id,
      agentId: agent.id,
    });
    await expect(budgeted!.client.search('refused')).rejects.toMatchObject({
      code: 'budget_exceeded',
      details: { scope_type: 'agent' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
