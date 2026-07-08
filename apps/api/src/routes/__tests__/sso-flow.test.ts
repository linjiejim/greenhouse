/**
 * SSO flow integration tests — the full login/bind glue over a real PostgreSQL
 * database and the real route + auth middleware stack, with a fake connector
 * injected through the EXTENSION_SSO_CONNECTORS seam (no network).
 *
 * Requires: PostgreSQL running at localhost:5432 with greenhouse_test database
 * (same harness as tests/db/* and packages/db crud-adapter tests).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

process.env.ACCESS_PASSWORD = 'test-secret-password-123';
process.env.TOKEN_SIGNING_KEY = 'dedicated-signing-key-for-tests-xyz';

import { Hono } from 'hono';
import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import ssoRoutes, { SSO_PASSWORD_SENTINEL } from '../sso.js';
import { authMiddleware } from '../../auth/middleware.js';
import { createAccessToken, validateAccessToken } from '../../auth/token.js';
import { EXTENSION_SSO_CONNECTORS } from '../../auth/sso/extensions.js';
import { _resetSsoConnectorsForTests } from '../../auth/sso/registry.js';
import type { SsoIdentity } from '../../auth/sso/types.js';
import type { AppEnv } from '../../app-env.js';

const PG_URL = 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test';
const SSO_ENV_KEYS = [
  'SSO_WECOM_CORP_ID',
  'SSO_WECOM_AGENT_ID',
  'SSO_WECOM_SECRET',
  'SSO_FEISHU_APP_ID',
  'SSO_FEISHU_APP_SECRET',
  'SSO_AUTO_PROVISION',
  'SSO_AUTO_PROVISION_ROLE',
  'SSO_PUBLIC_BASE_URL',
];

let db: DatabaseProvider;
let app: Hono<AppEnv>;
const savedEnv: Record<string, string | undefined> = {};

/** Per-code identity the fake connector returns (tests tweak fields inline). */
const fakeIdentities: Record<string, SsoIdentity> = {};

function locationOf(res: Response): URL {
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!, 'http://sso.test');
}

/** Run authorize and pull the signed state back out of the fake IdP URL. */
async function authorizeState(redirect: string): Promise<string> {
  const res = await app.request(`/api/auth/sso/fake/authorize?redirect=${encodeURIComponent(redirect)}`);
  const idpUrl = locationOf(res);
  expect(idpUrl.origin).toBe('https://idp.example');
  return idpUrl.searchParams.get('state')!;
}

describe('SSO flow (routes + DB + fake connector)', () => {
  beforeEach(async () => {
    for (const key of SSO_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    db = await initDatabase({ type: 'pg', pgConnectionString: PG_URL });
    await db.resetSchema();

    EXTENSION_SSO_CONNECTORS.length = 0;
    EXTENSION_SSO_CONNECTORS.push({
      id: 'fake',
      label: 'Fake IdP',
      buildAuthorizeUrl: ({ redirectUri, state }) =>
        `https://idp.example/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`,
      exchangeCode: async ({ code }) => {
        const identity = fakeIdentities[code];
        if (!identity) throw new Error('unknown code');
        return identity;
      },
    });
    _resetSsoConnectorsForTests();

    app = new Hono<AppEnv>();
    app.use('*', authMiddleware);
    app.route('/api/auth/sso', ssoRoutes);
  });

  afterEach(async () => {
    for (const key of SSO_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    EXTENSION_SSO_CONNECTORS.length = 0;
    _resetSsoConnectorsForTests();
    await db.close();
    _resetProvider();
  });

  it('login for an unbound identity fails with not_bound (JIT off)', async () => {
    fakeIdentities['c1'] = { subject: 'stranger' };
    const state = await authorizeState('/#chat');
    const res = await app.request(`/api/auth/sso/fake/callback?code=c1&state=${encodeURIComponent(state)}`);
    const landing = locationOf(res);
    expect(landing.searchParams.get('sso_error')).toBe('not_bound');
    expect(landing.hash).toBe('#chat');
  });

  it('bind → login → single-use ticket exchange round-trip', async () => {
    const user = await db.users.create({
      email: 'alice@test.com',
      password_hash: 'salt:key',
      nickname: 'Alice',
      role: 'team',
    });
    const bearer = { Authorization: `Bearer ${createAccessToken(user.id, 'team')}` };

    // 1. bind-url (authed) → IdP → callback with purpose=bind
    fakeIdentities['c2'] = { subject: 'alice-idp', displayName: 'Alice Wang', email: 'alice@corp.example' };
    const bindRes = await app.request('/api/auth/sso/fake/bind-url', {
      method: 'POST',
      headers: { ...bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect: '/#/settings/preferences' }),
    });
    expect(bindRes.status).toBe(200);
    const { url } = (await bindRes.json()) as { url: string };
    const bindState = new URL(url).searchParams.get('state')!;

    const bindCb = await app.request(`/api/auth/sso/fake/callback?code=c2&state=${encodeURIComponent(bindState)}`);
    const bindLanding = locationOf(bindCb);
    expect(bindLanding.searchParams.get('sso_bind')).toBe('ok');
    expect(bindLanding.hash).toBe('#/settings/preferences');

    const identity = await db.userIdentities.getByProviderSubject('fake', 'alice-idp');
    expect(identity?.user_id).toBe(user.id);

    // 2. identities list shows the binding
    const listRes = await app.request('/api/auth/sso/identities', { headers: bearer });
    expect(listRes.status).toBe(200);
    const listData = (await listRes.json()) as { identities: Array<{ provider: string; display_name: string }> };
    expect(listData.identities).toHaveLength(1);
    expect(listData.identities[0].provider).toBe('fake');

    // 3. SSO login with the bound identity → ticket landing
    const loginState = await authorizeState('/#chat');
    const loginCb = await app.request(`/api/auth/sso/fake/callback?code=c2&state=${encodeURIComponent(loginState)}`);
    const loginLanding = locationOf(loginCb);
    const ticket = loginLanding.searchParams.get('sso_ticket')!;
    expect(ticket).toBeTruthy();
    expect(loginLanding.hash).toBe('#chat');

    // 4. exchange → token pair for Alice; ticket is single-use
    const exchangeRes = await app.request('/api/auth/sso/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    expect(exchangeRes.status).toBe(200);
    const tokens = (await exchangeRes.json()) as { accessToken: string; refreshToken: string; user: { id: string } };
    expect(tokens.user.id).toBe(user.id);
    expect(validateAccessToken(tokens.accessToken)?.uid).toBe(user.id);
    expect(tokens.refreshToken).toBeTruthy();

    const replay = await app.request('/api/auth/sso/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    expect(replay.status).toBe(401);
  });

  it('an identity bound to one account cannot be bound to another', async () => {
    const alice = await db.users.create({ email: 'a@t.co', password_hash: 'x:y', nickname: 'A', role: 'team' });
    const bob = await db.users.create({ email: 'b@t.co', password_hash: 'x:y', nickname: 'B', role: 'team' });
    await db.userIdentities.create({ user_id: alice.id, provider: 'fake', subject: 'shared-subject' });

    fakeIdentities['c3'] = { subject: 'shared-subject' };
    const bindRes = await app.request('/api/auth/sso/fake/bind-url', {
      method: 'POST',
      headers: { Authorization: `Bearer ${createAccessToken(bob.id, 'team')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { url } = (await bindRes.json()) as { url: string };
    const state = new URL(url).searchParams.get('state')!;
    const cb = await app.request(`/api/auth/sso/fake/callback?code=c3&state=${encodeURIComponent(state)}`);
    expect(locationOf(cb).searchParams.get('sso_bind')).toBe('already_bound');
  });

  it('disabled accounts cannot log in via SSO', async () => {
    const user = await db.users.create({ email: 'd@t.co', password_hash: 'x:y', nickname: 'D', role: 'team' });
    await db.userIdentities.create({ user_id: user.id, provider: 'fake', subject: 'disabled-subject' });
    await db.users.update(user.id, { status: 'disabled' });

    fakeIdentities['c4'] = { subject: 'disabled-subject' };
    const state = await authorizeState('/');
    const cb = await app.request(`/api/auth/sso/fake/callback?code=c4&state=${encodeURIComponent(state)}`);
    expect(locationOf(cb).searchParams.get('sso_error')).toBe('account_disabled');
  });

  it('unbind works, but the last identity of a password-less account is protected', async () => {
    // Normal account — unbind fine.
    const alice = await db.users.create({ email: 'a2@t.co', password_hash: 'x:y', nickname: 'A', role: 'team' });
    await db.userIdentities.create({ user_id: alice.id, provider: 'fake', subject: 's1' });
    const del = await app.request('/api/auth/sso/identities/fake', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${createAccessToken(alice.id, 'team')}` },
    });
    expect(del.status).toBe(200);
    expect(await db.userIdentities.getByProviderSubject('fake', 's1')).toBeUndefined();

    // JIT (password-less) account — last identity refuses to unbind.
    const jit = await db.users.create({
      email: 'jit@sso.local',
      password_hash: SSO_PASSWORD_SENTINEL,
      nickname: 'J',
      role: 'team',
    });
    await db.userIdentities.create({ user_id: jit.id, provider: 'fake', subject: 's2' });
    const guarded = await app.request('/api/auth/sso/identities/fake', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${createAccessToken(jit.id, 'team')}` },
    });
    expect(guarded.status).toBe(400);
    expect(await db.userIdentities.getByProviderSubject('fake', 's2')).toBeDefined();
  });

  it('JIT provisioning creates a team account and rejects email conflicts', async () => {
    process.env.SSO_AUTO_PROVISION = 'true';

    // No email from the IdP → synthesized placeholder.
    fakeIdentities['c5'] = { subject: 'New.Hire', displayName: '新人' };
    let state = await authorizeState('/');
    let cb = await app.request(`/api/auth/sso/fake/callback?code=c5&state=${encodeURIComponent(state)}`);
    const ticket = locationOf(cb).searchParams.get('sso_ticket')!;
    const ex = await app.request('/api/auth/sso/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    const created = (await ex.json()) as { user: { id: string; email: string; role: string; nickname: string } };
    expect(created.user.email).toBe('fake-new-hire@sso.local');
    expect(created.user.role).toBe('team');
    expect(created.user.nickname).toBe('新人');
    const row = await db.users.getById(created.user.id);
    expect(row?.password_hash).toBe(SSO_PASSWORD_SENTINEL);
    expect(row?.created_by).toBe('sso:fake');

    // IdP email colliding with an existing account → explicit conflict, no merge.
    await db.users.create({ email: 'taken@corp.example', password_hash: 'x:y', nickname: 'T', role: 'team' });
    fakeIdentities['c6'] = { subject: 'someone-else', email: 'taken@corp.example' };
    state = await authorizeState('/');
    cb = await app.request(`/api/auth/sso/fake/callback?code=c6&state=${encodeURIComponent(state)}`);
    expect(locationOf(cb).searchParams.get('sso_error')).toBe('email_conflict');
  });

  it('rejects a state from a different provider or a forged state', async () => {
    fakeIdentities['c7'] = { subject: 'whoever' };
    const res = await app.request('/api/auth/sso/fake/callback?code=c7&state=forged.state');
    expect(locationOf(res).searchParams.get('sso_error')).toBe('invalid_state');
  });

  it('external (guest) tokens cannot use bind or identity endpoints', async () => {
    const guestBearer = { Authorization: `Bearer ${createAccessToken('external', 'external')}` };
    const bind = await app.request('/api/auth/sso/fake/bind-url', {
      method: 'POST',
      headers: { ...guestBearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(bind.status).toBe(403);
    const list = await app.request('/api/auth/sso/identities', { headers: guestBearer });
    expect(list.status).toBe(403);
  });
});
