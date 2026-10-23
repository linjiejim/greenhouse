/**
 * Services & pricing routes against real PostgreSQL, behind the same guards
 * `index.ts` mounts them with: the admin overview and budget writes are
 * super-only; a member reads only their own month through /api/usage/spend.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { MeteringOverview, MySpendReport } from '@greenhouse/types/metering';

import type { AppEnv } from '../../app-env.js';
import { requireInternal, requireSuper } from '../../auth/middleware.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import adminMeteringRoutes from '../admin-metering.js';
import { listActivity } from '../../activity/activity-log.js';
import { setPriceOverridesForTests } from '../../usage/pricing.js';
import usageRoutes from '../usage.js';

let db: DatabaseProvider;
let member: UserRow;
let otherMember: UserRow;
let admin: UserRow;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function app() {
  const users = new Map([member, otherMember, admin].map((user) => [user.id, user]));
  const hono = new Hono<AppEnv>();
  hono.use('*', async (c, next) => {
    const user = users.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role } as never);
    return next();
  });
  hono.use('/api/admin/*', requireSuper());
  hono.route('/api/admin/metering', adminMeteringRoutes);
  hono.use('/api/usage/*', requireInternal());
  hono.route('/api/usage', usageRoutes);
  return hono;
}

async function call(as: UserRow, method: string, path: string, body?: unknown) {
  const res = await app().request(path, {
    method,
    headers: { 'x-test-user': as.id, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  member = await createInternalTestUser(db, { email: `${unique('meter-route-member')}@test.local` });
  otherMember = await createInternalTestUser(db, { email: `${unique('meter-route-other')}@test.local` });
  admin = await createInternalTestUser(db, { email: `${unique('meter-route-admin')}@test.local`, role: 'super' });
});

afterEach(async () => {
  setPriceOverridesForTests([]);
  await db.close();
  _resetProvider();
});

describe('admin services & pricing', () => {
  it('is super-only, for reads and writes', async () => {
    expect((await call(member, 'GET', '/api/admin/metering/overview')).status).toBe(403);
    expect(
      (await call(member, 'PUT', '/api/admin/metering/budgets', { scope: 'organization', limit_usd_micros: 1 })).status,
    ).toBe(403);
    expect((await call(member, 'DELETE', '/api/admin/metering/budgets?scope=organization')).status).toBe(403);
  });

  it('returns prices, spend and budgets for a month', async () => {
    const res = await call(admin, 'GET', '/api/admin/metering/overview?month=2026-10');
    expect(res.status).toBe(200);
    const overview = res.json as unknown as MeteringOverview;
    expect(overview.period).toEqual({ start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' });
    expect(overview.services.map((service) => service.service)).toEqual([
      'web_search',
      'page_read',
      'image_generation',
      'vision',
      'computer',
    ]);
    expect(overview.budgets.services.map((budget) => budget.scope_id)).toContain('llm');
    expect((await call(admin, 'GET', '/api/admin/metering/overview?month=26-1')).status).toBe(400);
  });

  it('sets and resets a member override', async () => {
    const set = await call(admin, 'PUT', '/api/admin/metering/budgets', {
      scope: 'member',
      scope_id: member.id,
      limit_usd_micros: 3_000_000,
    });
    expect(set).toMatchObject({ status: 200, json: { ok: true, scope_type: 'user', limit_usd_micros: 3_000_000 } });
    const mine = (await call(member, 'GET', '/api/usage/spend')).json as unknown as MySpendReport;
    expect(mine.budget).toMatchObject({ limit_usd_micros: 3_000_000, source: 'override' });

    const reset = await call(admin, 'DELETE', `/api/admin/metering/budgets?scope=member&scope_id=${member.id}`);
    expect(reset).toMatchObject({ status: 200, json: { removed: true } });
  });

  it('rejects unknown scopes, services, members and bad amounts', async () => {
    const put = (body: unknown) => call(admin, 'PUT', '/api/admin/metering/budgets', body);
    expect((await put({ scope: 'galaxy', limit_usd_micros: 1 })).status).toBe(400);
    expect((await put({ scope: 'service', scope_id: 'teleport', limit_usd_micros: 1 })).status).toBe(400);
    expect((await put({ scope: 'member', scope_id: 'nobody', limit_usd_micros: 1 })).status).toBe(400);
    expect((await put({ scope: 'organization', limit_usd_micros: -1 })).status).toBe(400);
    expect((await put({ scope: 'organization', limit_usd_micros: 1.5 })).status).toBe(400);
    expect((await put({ scope: 'service', scope_id: 'web_search', limit_usd_micros: 0 })).status).toBe(200);
  });
});

describe('admin prices', () => {
  it('is super-only', async () => {
    const body = { kind: 'model', target: 'flash', input: 1, output: 2 };
    expect((await call(member, 'PUT', '/api/admin/metering/prices', body)).status).toBe(403);
    expect((await call(member, 'DELETE', '/api/admin/metering/prices?kind=model&target=flash')).status).toBe(403);
  });

  it('sets a model price, shows it as an override, and resets it to the config', async () => {
    const set = await call(admin, 'PUT', '/api/admin/metering/prices', {
      kind: 'model',
      target: 'flash',
      input: 0.28,
      output: 0.42,
      cached_input: 0.028,
    });
    expect(set.status).toBe(200);
    let overview = (await call(admin, 'GET', '/api/admin/metering/overview')).json as unknown as MeteringOverview;
    expect(overview.models.find((model) => model.id === 'flash')).toMatchObject({
      source: 'override',
      price: { input: 0.28, output: 0.42, cached_input: 0.028 },
    });

    const reset = await call(admin, 'DELETE', '/api/admin/metering/prices?kind=model&target=flash');
    expect(reset).toMatchObject({ status: 200, json: { removed: true } });
    overview = (await call(admin, 'GET', '/api/admin/metering/overview')).json as unknown as MeteringOverview;
    expect(overview.models.find((model) => model.id === 'flash')?.source).not.toBe('override');
  });

  it('takes a unit price for per-call services and token rates for per-token ones', async () => {
    const put = (body: unknown) => call(admin, 'PUT', '/api/admin/metering/prices', body);
    expect(
      (await put({ kind: 'service', target: 'web_search', provider: 'firecrawl', unit_price: 0.004 })).status,
    ).toBe(200);
    expect((await put({ kind: 'service', target: 'vision', provider: 'media', input: 0.15, output: 0.6 })).status).toBe(
      200,
    );
    // Wrong shape for the unit, unknown names, negative or absurd amounts.
    expect(
      (await put({ kind: 'service', target: 'web_search', provider: 'firecrawl', input: 1, output: 1 })).status,
    ).toBe(400);
    expect((await put({ kind: 'service', target: 'vision', provider: 'media', unit_price: 1 })).status).toBe(400);
    expect((await put({ kind: 'service', target: 'web_search', provider: 'bing', unit_price: 1 })).status).toBe(400);
    expect((await put({ kind: 'model', target: 'gpt-imaginary', input: 1, output: 1 })).status).toBe(400);
    expect((await put({ kind: 'model', target: 'flash', input: -1, output: 1 })).status).toBe(400);
    expect((await put({ kind: 'model', target: 'flash', input: 1, output: 1e9 })).status).toBe(400);
  });

  it('records price and budget changes as admin changes in the Activity log', async () => {
    await call(admin, 'PUT', '/api/admin/metering/prices', {
      kind: 'service',
      target: 'web_search',
      provider: 'tavily',
      unit_price: 0.01,
    });
    await call(admin, 'PUT', '/api/admin/metering/budgets', {
      scope: 'member',
      scope_id: member.id,
      limit_usd_micros: 3_000_000,
    });
    await call(admin, 'DELETE', `/api/admin/metering/budgets?scope=member&scope_id=${member.id}`);

    const page = await listActivity(db, admin, { source: 'admin', userId: admin.id }, { manifests: [] });
    const changes = page.items.filter((item) => item.actor.id === admin.id);
    expect(changes.map((item) => [item.action, item.module, item.detail]).reverse()).toEqual([
      ['updateServicePrice', 'settings', 'web_search/tavily: $0.01 per call'],
      ['updateBudgetLimit', 'settings', `member ${member.id}: $3.00 / month`],
      ['removeBudgetLimit', 'settings', `member ${member.id}: back to default`],
    ]);
    // A member never sees admin changes.
    expect((await listActivity(db, member, { source: 'admin' }, { manifests: [] })).items).toEqual([]);
  });
});

describe('member spend', () => {
  it('only ever reads the caller’s own facts', async () => {
    await db.metering.recordService({
      user_id: otherMember.id,
      service: 'web_search',
      provider: 'tavily',
      units: 1,
      unit_kind: 'call',
      cost_usd_micros: 8_000,
    });
    await db.metering.recordService({
      user_id: member.id,
      service: 'page_read',
      provider: 'jina',
      units: 1,
      unit_kind: 'call',
      cost_usd_micros: 0,
    });
    // A query parameter naming someone else changes nothing.
    const res = await call(member, 'GET', `/api/usage/spend?user_id=${otherMember.id}`);
    expect(res.status).toBe(200);
    const mine = res.json as unknown as MySpendReport;
    expect(mine.totals).toEqual({ cost_usd_micros: 0, calls: 1, unpriced_calls: 0 });
    expect(mine.by_service.map((row) => row.key)).toEqual(['page_read']);
    expect(mine.budget.scope_id).toBe(member.id);
  });
});
