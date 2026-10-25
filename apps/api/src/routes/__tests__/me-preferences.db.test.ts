/**
 * Member preferences (`/api/me/preferences`) and the plant avatar of a member's
 * connected agent (`PATCH /api/agent-access/connections/:clientId`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { initDatabase, _resetProvider, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import meRoutes from '../me.js';
import { createAgentAccessRoutes } from '../agent-access.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let user: UserRow;

function app(actor: UserRow) {
  return new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('user', { id: actor.id, email: actor.email, role: actor.role } as never);
      await next();
    })
    .route('/api/me', meRoutes)
    .route('/api/agent-access', createAgentAccessRoutes());
}

const json = (body: unknown) => ({
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('member preferences', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    user = await createInternalTestUser(db, { email: `prefs_${randomBytes(4).toString('hex')}@example.test` });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('defaults the font scale and saves a valid one', async () => {
    const server = app(user);
    expect(await (await server.request('/api/me/preferences')).json()).toEqual({ fontScale: 1 });

    const saved = await server.request('/api/me/preferences', json({ fontScale: 1.2 }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ fontScale: 1.2 });
    expect(await (await server.request('/api/me/preferences')).json()).toEqual({ fontScale: 1.2 });

    const stored = await db.users.getPreferences(user.id);
    expect(stored.fontScale).toBe(1.2);
  });

  it('accepts the small steps 0.8 and 0.85', async () => {
    const server = app(user);
    for (const fontScale of [0.8, 0.85]) {
      const saved = await server.request('/api/me/preferences', json({ fontScale }));
      expect(saved.status).toBe(200);
      expect(await (await server.request('/api/me/preferences')).json()).toEqual({ fontScale });
    }
  });

  it('rejects unknown keys and out-of-range values', async () => {
    const server = app(user);
    expect((await server.request('/api/me/preferences', json({ fontScale: 1.15 }))).status).toBe(400);
    expect((await server.request('/api/me/preferences', json({ fontScale: 0.75 }))).status).toBe(400);
    expect((await server.request('/api/me/preferences', json({ fontScale: 1, theme: 'dark' }))).status).toBe(400);
    expect((await server.request('/api/me/preferences', json([1]))).status).toBe(400);
    expect((await db.users.getPreferences(user.id)).fontScale).toBeUndefined();
  });

  it('files feedback as a request from the member, with the app context appended', async () => {
    const server = app(user);
    const post = (body: unknown) =>
      server.request('/api/me/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const made = await post({
      message: 'The table view is cramped\nRotating would help',
      context: { app: '3.0.0 (45)', station: 'green.example' },
    });
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    const saved = await db.featureRequests.getById(id);
    expect(saved).toMatchObject({ title: 'The table view is cramped', submitted_by: user.id, status: 'pending' });
    expect(saved?.description).toContain('Rotating would help');
    expect(saved?.description).toContain('- station: green.example');

    expect((await post({ message: '   ' })).status).toBe(400);
    expect((await post({ message: 'x'.repeat(4001) })).status).toBe(400);
    expect((await post({ message: 'ok', extra: 1 })).status).toBe(400);
  });

  it('sets, shows and clears a plant avatar on a connected agent', async () => {
    const client = await db.platformOAuth.registerClient({
      id: `ocl_test_${randomBytes(4).toString('hex')}`,
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost/callback'],
      token_endpoint_auth_method: 'none',
    } as never);
    await db.platformOAuth.upsertGrant({
      user_id: user.id,
      client_id: client.id,
      resource: 'http://localhost/api/mcp',
      scopes: ['mcp:read'],
    } as never);
    const server = app(user);

    const before = await (await server.request('/api/agent-access/connections')).json();
    expect(before.connections).toEqual([expect.objectContaining({ client_id: client.id, avatar: null })]);

    const set = await server.request(
      `/api/agent-access/connections/${client.id}`,
      json({ avatar: { plant: 'fern', tint: 'sky' } }),
    );
    expect(set.status).toBe(200);
    const after = await (await server.request('/api/agent-access/connections')).json();
    expect(after.connections[0].avatar).toEqual({ plant: 'fern', tint: 'sky' });

    expect(
      (
        await server.request(
          `/api/agent-access/connections/${client.id}`,
          json({ avatar: { plant: 'cactus', tint: 'sky' } }),
        )
      ).status,
    ).toBe(400);
    expect((await server.request('/api/agent-access/connections/nope', json({ avatar: null }))).status).toBe(404);

    expect((await server.request(`/api/agent-access/connections/${client.id}`, json({ avatar: null }))).status).toBe(
      200,
    );
    const cleared = await (await server.request('/api/agent-access/connections')).json();
    expect(cleared.connections[0].avatar).toBeNull();
  });
});
