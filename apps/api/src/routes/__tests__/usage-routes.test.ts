/**
 * Module usage routes: page opens accept only real module ids (so a client
 * cannot write arbitrary counter keys), label the client from the app header,
 * and never fail the page view when the count does; the admin report only
 * serves the offered ranges.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@greenhouse/utils/logger';
import type { AppEnv } from '../../app-env.js';

const mocks = vi.hoisted(() => ({
  usageCounters: { increment: vi.fn(), summarize: vi.fn() },
  usage: { getCacheHitByModel: vi.fn() },
}));

vi.mock('@greenhouse/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@greenhouse/db')>()),
  getDb: () => mocks,
}));

vi.mock('../../extensions/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../extensions/index.js')>()),
  EXTENSIONS: [{ id: 'example' }],
}));

import usageRoutes from '../usage.js';
import adminRoutes from '../admin.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'u1', role: 'super' } as never);
    return next();
  });
  app.route('/api/usage', usageRoutes);
  app.route('/api/admin', adminRoutes);
  return app;
}

function pageOpen(body: unknown, headers: Record<string, string> = {}) {
  return createApp().request('/api/usage/page-open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.usageCounters.increment.mockResolvedValue(undefined);
  mocks.usageCounters.summarize.mockResolvedValue([]);
  mocks.usage.getCacheHitByModel.mockResolvedValue([]);
});

describe('POST /api/usage/page-open', () => {
  it('counts a core module from the web app', async () => {
    const res = await pageOpen({ module: 'knowledge' });
    expect(res.status).toBe(202);
    expect(mocks.usageCounters.increment).toHaveBeenCalledWith('page_open', 'knowledge', 'web');
  });

  it('labels the client from the app header and ignores unknown header values', async () => {
    await pageOpen({ module: 'settings.desktop' }, { 'X-Greenhouse-Client': 'desktop' });
    await pageOpen({ module: 'chat' }, { 'X-Greenhouse-Client': 'Mobile' });
    await pageOpen({ module: 'chat' }, { 'X-Greenhouse-Client': 'evil' });
    expect(mocks.usageCounters.increment.mock.calls).toEqual([
      ['page_open', 'settings.desktop', 'desktop'],
      ['page_open', 'chat', 'mobile'],
      ['page_open', 'chat', 'web'],
    ]);
  });

  it('accepts an active extension module and rejects an inactive one', async () => {
    expect((await pageOpen({ module: 'ext.example' })).status).toBe(202);
    expect((await pageOpen({ module: 'ext.crm' })).status).toBe(400);
    expect(mocks.usageCounters.increment).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ module: 'not-a-module' }],
    [{ module: 'admin.users; drop table' }],
    [{ module: 42 }],
    [{}],
    [[]],
    ['not json'],
  ])('rejects %j without writing', async (body) => {
    const res = await pageOpen(body);
    expect(res.status).toBe(400);
    expect(mocks.usageCounters.increment).not.toHaveBeenCalled();
  });

  it('still answers 202 when the count cannot be written', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mocks.usageCounters.increment.mockRejectedValue(new Error('db down'));
    const res = await pageOpen({ module: 'projects' });
    expect(res.status).toBe(202);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
    warn.mockRestore();
  });
});

describe('GET /api/admin/usage/modules', () => {
  it('serves 7 / 30 / 90 day ranges with both kinds and the cache rate', async () => {
    mocks.usageCounters.summarize.mockImplementation(async (kind: string) =>
      kind === 'tool_call'
        ? [{ key: 'knowledge_query', client: 'mcp', count: 3 }]
        : [{ key: 'chat', client: 'web', count: 2 }],
    );
    mocks.usage.getCacheHitByModel.mockResolvedValue([
      { model: 'm', calls: 1, input_tokens: 10, cached_tokens: 5, hit_rate: 0.5 },
    ]);

    const res = await createApp().request('/api/admin/usage/modules?days=7');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      days: 7,
      tool_calls: [{ key: 'knowledge_query', client: 'mcp', count: 3 }],
      page_opens: [{ key: 'chat', client: 'web', count: 2 }],
      cache_by_model: [{ model: 'm', hit_rate: 0.5 }],
    });
    const range = { from: body.from, to: body.to };
    expect(mocks.usageCounters.summarize).toHaveBeenCalledWith('tool_call', range);
    expect(mocks.usage.getCacheHitByModel).toHaveBeenCalledWith({ since: `${String(body.from)}T00:00:00.000Z` });
  });

  it.each(['1', '365', 'abc'])('rejects days=%s', async (days) => {
    const res = await createApp().request(`/api/admin/usage/modules?days=${days}`);
    expect(res.status).toBe(400);
    expect(mocks.usageCounters.summarize).not.toHaveBeenCalled();
  });
});
