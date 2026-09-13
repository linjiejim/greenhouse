import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../app-env.js';
import clientActionRoutes from '../client-actions.js';
import { createClientActionBridge } from '../../tools/client-action-bridge.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: c.req.header('x-user') ?? 'user-a', role: 'team' });
    return next();
  });
  app.route('/api/client-actions', clientActionRoutes);
  return app;
}

describe('client action result route', () => {
  it('accepts only the pending action owned by the authenticated user', async () => {
    const app = createApp();
    const bridge = createClientActionBridge('owner', 'sess-1');
    bridge.setWriter(async () => {});
    const execution = bridge.requestExecution('crm_navigate', {}, 'call-1');

    const otherUser = await app.request('/api/client-actions/tool-result', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': 'other' },
      body: JSON.stringify({ session_id: 'sess-1', toolCallId: 'call-1', output: { ok: true } }),
    });
    expect(otherUser.status).toBe(200);
    await expect(otherUser.json()).resolves.toEqual({ ok: true, resolved: false });

    await vi.waitFor(async () => {
      const owner = await app.request('/api/client-actions/tool-result', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user': 'owner' },
        body: JSON.stringify({ session_id: 'sess-1', toolCallId: 'call-1', output: { ok: true } }),
      });
      expect(await owner.json()).toEqual({ ok: true, resolved: true });
    });
    await expect(execution).resolves.toEqual({ ok: true });
  });

  it('validates identifiers and exposes no capabilities endpoint', async () => {
    const app = createApp();
    const invalid = await app.request('/api/client-actions/tool-result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(invalid.status).toBe(400);

    const capabilities = await app.request('/api/client-actions/capabilities');
    expect(capabilities.status).toBe(404);
  });
});
