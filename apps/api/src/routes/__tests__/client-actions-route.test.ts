/**
 * The Client Action result route answers at the one shared path both clients
 * import (CLIENT_ACTION_RESULT_PATH): the web app and the browser extension.
 * The extension once posted to a renamed path for months with every result lost.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { CLIENT_ACTION_RESULT_PATH, CLIENT_ACTIONS_API_PREFIX } from '@greenhouse/types/api';
import type { AppEnv } from '../../app-env.js';
import clientActionRoutes from '../client-actions.js';

describe('Client Action result route', () => {
  it('answers at the shared result path when mounted at the shared prefix', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('user', { id: 'owner', role: 'team' } as never);
      return next();
    });
    app.route(CLIENT_ACTIONS_API_PREFIX, clientActionRoutes);

    const response = await app.request(CLIENT_ACTION_RESULT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'session-1', toolCallId: 'call-1', output: { ok: true } }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, resolved: false });
  });
});
