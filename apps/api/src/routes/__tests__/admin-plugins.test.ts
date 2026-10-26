import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../app-env.js';
const status = vi.hoisted(() => vi.fn(async () => []));
vi.mock('../../extensions/status.js', () => ({ pluginStatus: status }));
vi.mock('@greenhouse/db', () => ({ getDb: () => ({}) }));
import route from '../admin-plugins.js';
function app(role: 'super' | 'team') {
  return new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('user', { id: 'fixture', role });
      await next();
    })
    .route('/api/admin/plugins', route);
}
describe('GET /api/admin/plugins', () => {
  it('guards both bare and trailing-slash paths from members', async () => {
    for (const path of ['/api/admin/plugins', '/api/admin/plugins/'])
      expect((await app('team').request(path)).status).toBe(403);
    expect(status).not.toHaveBeenCalled();
  });
  it('returns the operator model only for super', async () => {
    const response = await app('super').request('/api/admin/plugins');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ plugins: [] });
  });
});
