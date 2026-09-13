/**
 * Home workbench card evaluation (real PostgreSQL).
 *
 * The contract worth pinning is the one the whole design rests on: a card
 * stores a query, not an answer, so access is decided at evaluation time. Take
 * a tool away and the card must go grey — not keep serving yesterday's rows,
 * and not take the rest of the page down with it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import type { ToolRegistry } from '../../agent.js';
import { createWorkbenchRoutes } from '../workbench.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests, PLATFORM_ORG_ID } from '../../platform/runtime.js';
import { projectsRegistration } from '../../platform/projects/application.js';

let db: DatabaseProvider;

/**
 * The route builds its own per-request lazy tools, so a fake registry would be
 * shadowed anyway. Cards below bind `project_query` — read-proxy, global to
 * every internal user — which exercises the real resolveUserTools → allowlist →
 * platform dispatch chain without needing project fixtures.
 */
const EMPTY_REGISTRY = {} as ToolRegistry;

function createApp(users: UserRow[], registry: ToolRegistry) {
  const byId = new Map(users.map((user) => [user.id, user]));
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const user = byId.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  app.route('/api/workbench', createWorkbenchRoutes(registry));
  return app;
}

async function saveCards(userId: string, widgets: unknown[]) {
  await db.platform.setUserWorkbenchPreferences(PLATFORM_ORG_ID, userId, {
    version: 2,
    appOrder: [],
    pinnedAppIds: [],
    hiddenAppIds: [],
    defaultAppId: null,
    density: 'comfortable',
    tabs: [{ id: 'main', title: 'Overview', position: 0 }],
    widgets: widgets as never,
  });
}

const layout = { tabId: 'main', x: 0, y: 0, w: 4, h: 3 };

function dataCard(id: string, toolId: string) {
  return {
    id,
    title: id,
    kind: 'data',
    display: 'table',
    layout,
    source: { toolId, input: { action: 'list' } },
  };
}

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  // Cards resolve through the platform runtime, exactly as they do in the app.
  resetPlatformRuntimeForTests();
  initializePlatformRuntime(db, [projectsRegistration]);
});

describe('POST /api/workbench/query', () => {
  it('evaluates a saved card as the requesting user', async () => {
    const user = await createInternalTestUser(db, {
      email: `wb-team-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
      role: 'team',
    });
    await saveCards(user.id, [dataCard('projects', 'project_query')]);
    const app = createApp([user], EMPTY_REGISTRY);

    const response = await app.request('/api/workbench/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user.id },
      body: JSON.stringify({ requests: [{ widgetId: 'projects' }] }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: Array<Record<string, unknown>> };
    expect(body.results[0]).toMatchObject({ index: 0, ok: true });
  });

  it('refuses a card whose tool the user cannot call, without failing the batch', async () => {
    const user = await createInternalTestUser(db, {
      email: `wb-team-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
      role: 'team',
    });
    // restricted_query is not in this user's readable tool set.
    await saveCards(user.id, [dataCard('projects', 'project_query'), dataCard('sales', 'restricted_query')]);
    const app = createApp([user], EMPTY_REGISTRY);

    const response = await app.request('/api/workbench/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user.id },
      body: JSON.stringify({ requests: [{ widgetId: 'projects' }, { widgetId: 'sales' }] }),
    });

    const body = (await response.json()) as { results: Array<Record<string, unknown>> };
    // Results keep their request order so the client can match them by index.
    expect(body.results.map((result) => result.index)).toEqual([0, 1]);
    expect(body.results[0]).toMatchObject({ ok: true });
    expect(body.results[1]).toMatchObject({ ok: false, error: 'forbidden' });
  });

  it('refuses a write tool even when the user is allowed to use it elsewhere', async () => {
    const user = await createInternalTestUser(db, {
      email: `wb-super-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
      role: 'super',
    });
    await saveCards(user.id, [dataCard('mutate', 'project_mutation')]);
    const app = createApp([user], EMPTY_REGISTRY);

    const response = await app.request('/api/workbench/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user.id },
      body: JSON.stringify({ requests: [{ widgetId: 'mutate' }] }),
    });

    const body = (await response.json()) as { results: Array<Record<string, unknown>> };
    expect(body.results[0]).toMatchObject({ ok: false, error: 'forbidden' });
  });

  it('reports an unknown card id rather than inventing one', async () => {
    const user = await createInternalTestUser(db, {
      email: `wb-team-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
      role: 'team',
    });
    await saveCards(user.id, []);
    const app = createApp([user], EMPTY_REGISTRY);

    const response = await app.request('/api/workbench/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user.id },
      body: JSON.stringify({ requests: [{ widgetId: 'ghost' }] }),
    });

    const body = (await response.json()) as { results: Array<Record<string, unknown>> };
    expect(body.results[0]).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('never evaluates a source supplied in the request body', async () => {
    const user = await createInternalTestUser(db, {
      email: `wb-team-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
      role: 'team',
    });
    await saveCards(user.id, []);
    const app = createApp([user], EMPTY_REGISTRY);

    // The only address is a stored card id. An inline source is refused both
    // when smuggled alongside a widgetId and when sent on its own — there is no
    // second route into the executor.
    const inlineSource = { toolId: 'project_query', input: { action: 'list' } };
    const response = await app.request('/api/workbench/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user.id },
      body: JSON.stringify({
        requests: [{ widgetId: 'ghost', previewSource: inlineSource }, { previewSource: inlineSource }],
      }),
    });

    const body = (await response.json()) as { results: Array<Record<string, unknown>> };
    expect(body.results[0]).toMatchObject({ ok: false, error: 'not_found' });
    expect(body.results[1]).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('caps the batch size', async () => {
    const user = await createInternalTestUser(db, {
      email: `wb-team-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
      role: 'team',
    });
    await saveCards(user.id, []);
    const app = createApp([user], EMPTY_REGISTRY);

    const response = await app.request('/api/workbench/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user.id },
      body: JSON.stringify({ requests: Array.from({ length: 31 }, () => ({ widgetId: 'x' })) }),
    });

    expect(response.status).toBe(400);
  });
});
