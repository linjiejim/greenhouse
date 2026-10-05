/**
 * /api/bots/computer error shape: `{ error, code }`, plus `reason: 'host_disk'`
 * when `over_quota` is the Docker host's disk rather than the member's home
 * (the page must not tell the member to clear their Downloads for that).
 */

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ComputerUnavailableError } from '../errors.js';

const ensureRunning = vi.hoisted(() => vi.fn());
vi.mock('../runtime.js', () => ({
  requireComputerRuntime: () => ({ controller: { ensureRunning } }),
  computerStatusFor: vi.fn(async () => ({ state: 'running' })),
  adminComputersView: vi.fn(),
  purgeUserComputer: vi.fn(),
  stopUserComputer: vi.fn(),
}));

const { createBotsComputerRoutes } = await import('../routes.js');

function app() {
  return new Hono()
    .use('*', async (c, next) => {
      c.set('user' as never, { id: 'u1', role: 'team' } as never);
      await next();
    })
    .route('/', createBotsComputerRoutes());
}

describe('computer route errors', () => {
  it('marks a full Docker disk as reason host_disk, and leaves the member’s own over-quota alone', async () => {
    ensureRunning.mockRejectedValueOnce(
      new ComputerUnavailableError('over_quota', 'The server is almost out of disk space.', 'host_disk'),
    );
    const host = await app().request('/start', { method: 'POST' });
    expect(host.status).toBe(409);
    expect(await host.json()).toEqual({
      error: 'The server is almost out of disk space.',
      code: 'over_quota',
      reason: 'host_disk',
    });

    ensureRunning.mockRejectedValueOnce(
      new ComputerUnavailableError('over_quota', 'The computer is out of disk space.'),
    );
    const member = await app().request('/start', { method: 'POST' });
    expect(await member.json()).toEqual({ error: 'The computer is out of disk space.', code: 'over_quota' });
  });
});
