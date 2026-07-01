/**
 * GUARD + BEHAVIOR TEST — the route fork extension point (routes/extensions.ts).
 *
 * Upstream must ship ZERO private routes (EXTRA_ROUTES empty). The behavior test
 * proves the seam works: a fork-contributed route mounts under its path and its
 * declared guard middleware runs — so a fork adds routes by editing only
 * extensions.ts, never index.ts.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Hono } from 'hono';
import { EXTRA_ROUTES, mountExtraRoutes, type ExtraRoute } from '../extensions.js';
import type { AppEnv } from '../../app-env.js';
import type { ToolRegistry } from '../../agent.js';

const fakeRegistry = {} as ToolRegistry;

afterEach(() => {
  EXTRA_ROUTES.length = 0;
});

describe('route extension seam', () => {
  it('ships no private routes upstream (OSS invariant)', () => {
    expect(EXTRA_ROUTES).toHaveLength(0);
  });

  it('mounts a fork-contributed route and applies its guard middleware', async () => {
    const calls: string[] = [];
    const route: ExtraRoute = {
      path: '/api/demo',
      use: [
        async (_c, next) => {
          calls.push('guard');
          await next();
        },
      ],
      create: () => new Hono<AppEnv>().get('/ping', (c) => c.json({ ok: true })),
    };
    EXTRA_ROUTES.push(route);

    const app = new Hono<AppEnv>();
    mountExtraRoutes(app, fakeRegistry);

    const res = await app.request('/api/demo/ping');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual(['guard']);
  });
});
