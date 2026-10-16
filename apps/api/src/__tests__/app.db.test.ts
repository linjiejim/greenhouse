import { describe, expect, it } from 'vitest';
import { createTestApp } from '../testing.js';

describe('the HTTP surface', () => {
  it('reports setup until an admin is active, and answers errors in one envelope', async () => {
    const { call, member } = createTestApp();
    expect((await call('GET', '/api/bootstrap')).body).toMatchObject({ api_version: 2, setup_pending: true });
    const admin = await member('admin');
    expect((await call('GET', '/api/bootstrap')).body.setup_pending).toBe(false);

    // Unknown endpoints stay hidden until signed in.
    expect((await call('GET', '/api/nope')).status).toBe(401);
    expect((await call('GET', '/api/nope', { token: admin.token })).body).toEqual({
      error: { code: 'not_found', message: 'No such endpoint.' },
    });
    const invalid = await call('POST', '/api/auth/login', { body: { email: 'not-an-email', password: '' } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('invalid_input');
    expect(invalid.body.error.details.length).toBeGreaterThan(0);
  });

  it('lets an admin rename the workspace', async () => {
    const { call, member } = createTestApp();
    const admin = await member('admin');
    const branded = await call('PATCH', '/api/admin/branding', {
      token: admin.token,
      body: { name: 'Acme', primary_color: '#235D4D' },
    });
    expect(branded.body).toMatchObject({ name: 'Acme', primary_color: '#235D4D' });
  });

  it('rejects tampered and expired access tokens', async () => {
    const { call, member, services } = createTestApp();
    const lin = await member();
    const [payload, signature] = lin.token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ sub: lin.id, role: 'admin', ver: 0, exp: 9e9 })).toString('base64url')}.${signature}`;
    expect((await call('GET', '/api/me', { token: forged })).status).toBe(401);
    expect((await call('GET', '/api/me', { token: `${payload}.x` })).status).toBe(401);
    const expired = services.tokens.createAccessToken(lin.id, 'member', 0, Date.now() - 5 * 60 * 60 * 1000);
    expect((await call('GET', '/api/me', { token: expired })).status).toBe(401);
  });
});
