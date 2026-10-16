/**
 * POST /api/auth/login             email + password → token pair
 * POST /api/auth/refresh           single-use refresh token → new pair
 * POST /api/auth/logout            revoke a refresh token
 * GET  /api/auth/links/inspect     ?token= → what the one-time link is for
 * POST /api/auth/links/complete    token + password → activate or reset, then signed in
 */

import { Hono } from 'hono';
import { completeLinkInputSchema, loginInputSchema, refreshInputSchema } from '@greenhouse/contract';
import { z } from 'zod';
import { ApiError } from '../../http/errors.js';
import type { AppEnv } from '../../http/env.js';
import { readJson, readQuery } from '../../http/validate.js';
import type { RateLimiter } from '../../security/rate-limit.js';
import type { AuthService } from './service.js';

export function authRoutes(deps: { auth: AuthService; limiter: RateLimiter; clientIp: (c: unknown) => string }) {
  const { auth, limiter } = deps;
  const throttle = async (key: string) => {
    const wait = await limiter.hit(key);
    if (wait > 0) throw new ApiError(429, 'rate_limited', `Too many attempts. Try again in ${wait} seconds.`);
  };

  return new Hono<AppEnv>()
    .post('/login', async (c) => {
      const input = await readJson(c, loginInputSchema);
      await throttle(`login:ip:${deps.clientIp(c)}`);
      await throttle(`login:email:${input.email}`);
      const pair = await auth.login(input);
      await limiter.reset(`login:email:${input.email}`);
      return c.json(pair);
    })
    .post('/refresh', async (c) => {
      const input = await readJson(c, refreshInputSchema);
      return c.json(await auth.refresh(input.refresh_token));
    })
    .post('/logout', async (c) => {
      const input = await readJson(c, refreshInputSchema);
      await auth.logout(input.refresh_token);
      return c.body(null, 204);
    })
    .get('/links/inspect', async (c) => {
      const { token } = readQuery(c, z.object({ token: z.string().min(16).max(256) }));
      await throttle(`link:ip:${deps.clientIp(c)}`);
      return c.json(await auth.inspectLink(token));
    })
    .post('/links/complete', async (c) => {
      const input = await readJson(c, completeLinkInputSchema);
      await throttle(`link:ip:${deps.clientIp(c)}`);
      return c.json(await auth.completeLink(input));
    });
}
