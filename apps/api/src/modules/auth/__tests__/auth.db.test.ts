import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, members } from '@greenhouse/db';
import { createTestApp, TEST_PASSWORD } from '../../../testing.js';
import { ensureFirstAdmin } from '../../../security/first-admin.js';

const tokenFrom = (url: string) => new URL(url.replace('/#/', '/')).searchParams.get('token')!;

describe('sign-in', () => {
  it('signs in with email and password and rejects a wrong password with the same error as an unknown email', async () => {
    const { call, member } = createTestApp();
    const lin = await member();
    const ok = await call('POST', '/api/auth/login', { body: { email: lin.email, password: TEST_PASSWORD } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ expires_in: 14_400 });
    const me = await call('GET', '/api/me', { token: ok.body.access_token });
    expect(me.body).toMatchObject({ id: lin.id, role: 'member' });

    const wrong = await call('POST', '/api/auth/login', { body: { email: lin.email, password: 'nope-nope' } });
    const unknown = await call('POST', '/api/auth/login', {
      body: { email: 'ghost@example.com', password: 'nope-nope' },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
    expect(wrong.body.error.code).toBe('invalid_credentials');
  });

  it('throttles repeated attempts for one email', async () => {
    const { call, member } = createTestApp();
    const lin = await member();
    let last = 0;
    for (let attempt = 0; attempt < 11; attempt++) {
      last = (await call('POST', '/api/auth/login', { body: { email: lin.email, password: 'wrong-wrong' } })).status;
    }
    expect(last).toBe(429);
  });

  it('rotates refresh tokens and revokes every session when a used one comes back', async () => {
    const { call, member } = createTestApp();
    const lin = await member();
    const first = (await call('POST', '/api/auth/login', { body: { email: lin.email, password: TEST_PASSWORD } })).body;
    const second = await call('POST', '/api/auth/refresh', { body: { refresh_token: first.refresh_token } });
    expect(second.status).toBe(200);
    const replay = await call('POST', '/api/auth/refresh', { body: { refresh_token: first.refresh_token } });
    expect(replay.status).toBe(401);
    // The replay revoked the fresh token too.
    const after = await call('POST', '/api/auth/refresh', { body: { refresh_token: second.body.refresh_token } });
    expect(after.status).toBe(401);
  });

  it('ends a session on logout', async () => {
    const { call, member } = createTestApp();
    const lin = await member();
    const pair = (await call('POST', '/api/auth/login', { body: { email: lin.email, password: TEST_PASSWORD } })).body;
    expect((await call('POST', '/api/auth/logout', { body: { refresh_token: pair.refresh_token } })).status).toBe(204);
    expect((await call('POST', '/api/auth/refresh', { body: { refresh_token: pair.refresh_token } })).status).toBe(401);
  });

  it('activates an invited member through a one-time link, once', async () => {
    const { call, member } = createTestApp();
    const admin = await member('admin');
    const invite = await call('POST', '/api/admin/members', {
      token: admin.token,
      body: { email: 'Chen@Example.com', name: '陈晨' },
    });
    expect(invite.status).toBe(201);
    expect(invite.body.member).toMatchObject({ email: 'chen@example.com', status: 'invited', role: 'member' });
    const token = tokenFrom(invite.body.link.url);

    const info = await call('GET', `/api/auth/links/inspect?token=${token}`);
    expect(info.body).toEqual({ purpose: 'activate', email: 'chen@example.com', name: '陈晨' });

    const done = await call('POST', '/api/auth/links/complete', { body: { token, password: 'a-good-password' } });
    expect(done.status).toBe(200);
    expect((await call('GET', '/api/me', { token: done.body.access_token })).body.name).toBe('陈晨');
    const again = await call('POST', '/api/auth/links/complete', { body: { token, password: 'another-password' } });
    expect(again.body.error.code).toBe('link_invalid');
  });

  it('creates the first admin once and never promotes an existing member', async () => {
    const { services, member } = createTestApp();
    const url = await ensureFirstAdmin('Root@Example.com', services.auth);
    expect(url).toContain('/#/activate?token=');
    const [root] = await getDb().select().from(members).where(eq(members.email, 'root@example.com'));
    expect(root).toMatchObject({ role: 'admin', status: 'invited' });
    expect(await ensureFirstAdmin('other@example.com', services.auth)).toBeNull();

    const fresh = createTestApp();
    await getDb().delete(members).where(eq(members.id, root!.id));
    const existing = await member('member', 'someone@example.com');
    expect(await ensureFirstAdmin('someone@example.com', fresh.services.auth)).toBeNull();
    const [still] = await getDb().select().from(members).where(eq(members.id, existing.id));
    expect(still!.role).toBe('member');
  });
});
