/**
 * Vault service + /api/bots/vault routes on real PostgreSQL: secrets are
 * write-only (never in a response, ciphertext at rest bound to its row), and
 * every route is owner-scoped (another member's entry is a 404).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { VaultItemView } from '@greenhouse/types/bots';
import type { AppEnv } from '../../../app-env.js';
import { createBotsVaultRoutes } from '../routes.js';
import { recordVaultAccess, revealVaultSecrets, saveSecureLogin, vaultMatchesForOrigin } from '../service.js';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';

const KEY = 'f6'.repeat(32);
const originalKey = process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
const originalBase = process.env.PUBLIC_BASE_URL;

let db: DatabaseProvider;
let alice: UserRow;
let bob: UserRow;
let app: Hono<AppEnv>;

beforeAll(() => {
  process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = KEY;
  process.env.PUBLIC_BASE_URL = 'https://greenhouse.example.com';
});
afterAll(() => {
  if (originalKey === undefined) delete process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
  else process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = originalKey;
  if (originalBase === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = originalBase;
});

beforeEach(async () => {
  process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = KEY;
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  alice = await createInternalTestUser(db, { email: `alice-${stamp}@test.local` });
  bob = await createInternalTestUser(db, { email: `bob-${stamp}@test.local` });
  const users = new Map([alice, bob].map((u) => [u.id, u]));
  app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const user = users.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  app.route('/api/bots/vault', createBotsVaultRoutes());
});

async function call(user: UserRow, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api/bots/vault${path}`, {
    method,
    headers: { 'x-test-user': user.id, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const GITHUB = {
  label: 'GitHub',
  origins: ['github.com', '*.github.com'],
  username: 'alice@example.com',
  password: 'correct horse battery staple',
  totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
};

describe('creating and reading entries', () => {
  it('stores secrets encrypted and never returns them', async () => {
    const created = await call(alice, 'POST', '', GITHUB);
    expect(created.status).toBe(201);
    const item = created.json.item as VaultItemView;
    expect(item).toMatchObject({
      label: 'GitHub',
      origins: ['https://github.com', '*.github.com'],
      username_hint: 'al***@example.com',
      has_password: true,
      has_totp: true,
      policy: 'ask',
      always_origins: [],
    });
    for (const secret of [GITHUB.username, GITHUB.password, GITHUB.totp]) expect(created.text).not.toContain(secret);

    const list = await call(alice, 'GET', '');
    expect(list.json).toMatchObject({ available: true, items: [expect.objectContaining({ id: item.id })] });
    for (const secret of [GITHUB.username, GITHUB.password, GITHUB.totp]) expect(list.text).not.toContain(secret);

    const row = (await db.vault.get(alice.id, item.id))!;
    expect(row.password_enc).not.toContain('horse');
    expect(revealVaultSecrets(alice.id, row, ['username', 'password', 'totp'])).toEqual({
      username: GITHUB.username,
      password: GITHUB.password,
      totp: GITHUB.totp,
    });
    // Ciphertext is bound to its owner: the same row under another user id fails.
    expect(() => revealVaultSecrets(bob.id, row, ['password'])).toThrow();
  });

  it('validates sites, names and authenticator secrets', async () => {
    expect((await call(alice, 'POST', '', { origins: ['github.com'] })).json).toMatchObject({ code: 'invalid' });
    expect((await call(alice, 'POST', '', { label: 'x' })).json).toMatchObject({ code: 'invalid' });
    expect((await call(alice, 'POST', '', { ...GITHUB, origins: ['https://github.com/login'] })).json).toMatchObject({
      code: 'origin_invalid',
    });
    expect((await call(alice, 'POST', '', { ...GITHUB, origins: ['http://github.com'] })).json).toMatchObject({
      code: 'origin_invalid',
    });
    expect(
      (await call(alice, 'POST', '', { ...GITHUB, origins: ['https://greenhouse.example.com'] })).json,
    ).toMatchObject({ code: 'origin_forbidden' });
    expect((await call(alice, 'POST', '', { ...GITHUB, totp: 'not base32!' })).json).toMatchObject({
      code: 'totp_invalid',
    });
    expect((await call(alice, 'POST', '', { ...GITHUB, label: '   ' })).json).toMatchObject({ code: 'label_invalid' });
    expect((await call(alice, 'POST', '', { ...GITHUB, label: 'x'.repeat(61) })).json).toMatchObject({
      code: 'label_invalid',
    });
    expect((await call(alice, 'POST', '', { ...GITHUB, owner: bob.id })).status).toBe(400);
    expect((await call(alice, 'GET', '')).json.items).toEqual([]);
  });

  it('is explicitly unavailable without an encryption key', async () => {
    delete process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
    const created = await call(alice, 'POST', '', GITHUB);
    expect(created.status).toBe(503);
    expect(created.json).toMatchObject({ code: 'vault_unavailable' });
    expect((await call(alice, 'GET', '')).json).toMatchObject({ available: false, items: [] });
  });
});

describe('editing', () => {
  it('keeps omitted secrets, clears on empty string, and prunes stale "always" grants', async () => {
    const item = (await call(alice, 'POST', '', GITHUB)).json.item as VaultItemView;
    await db.vault.update(alice.id, item.id, { always_origins: ['https://github.com', 'https://gist.github.com'] });

    const renamed = await call(alice, 'PATCH', `/${item.id}`, { label: 'GitHub (work)' });
    expect(renamed.json.item).toMatchObject({ label: 'GitHub (work)', has_password: true, has_totp: true });

    const cleared = await call(alice, 'PATCH', `/${item.id}`, { password: '', totp: '', username: '' });
    expect(cleared.json.item).toMatchObject({ has_password: false, has_totp: false, username_hint: '' });

    const narrowed = await call(alice, 'PATCH', `/${item.id}`, { origins: ['https://github.com'] });
    expect(narrowed.json.item).toMatchObject({
      origins: ['https://github.com'],
      always_origins: ['https://github.com'],
    });

    const repassword = await call(alice, 'PATCH', `/${item.id}`, { password: 'new pass' });
    expect(repassword.json.item).toMatchObject({ has_password: true });
    expect(repassword.text).not.toContain('new pass');
    expect(revealVaultSecrets(alice.id, (await db.vault.get(alice.id, item.id))!, ['password'])).toEqual({
      password: 'new pass',
    });
  });
});

describe('isolation between members', () => {
  it("makes another member's entry indistinguishable from a missing one", async () => {
    const item = (await call(alice, 'POST', '', GITHUB)).json.item as VaultItemView;

    expect((await call(bob, 'GET', '')).json.items).toEqual([]);
    expect((await call(bob, 'PATCH', `/${item.id}`, { label: 'mine now' })).status).toBe(404);
    expect((await call(bob, 'PATCH', `/${item.id}`, { password: 'pwned' })).status).toBe(404);
    expect((await call(bob, 'DELETE', `/${item.id}`)).status).toBe(404);
    expect((await call(alice, 'GET', '')).json.items).toEqual([expect.objectContaining({ label: 'GitHub' })]);

    expect((await call(alice, 'DELETE', `/${item.id}`)).json).toEqual({ ok: true });
    expect((await call(alice, 'DELETE', `/${item.id}`)).status).toBe(404);
  });

  it('shows each member only their own access log, metadata only', async () => {
    const item = (await call(alice, 'POST', '', GITHUB)).json.item as VaultItemView;
    await recordVaultAccess(db, {
      user_id: alice.id,
      item_id: item.id,
      item_label: 'GitHub',
      bot_id: null,
      session_id: null,
      origin: 'https://github.com',
      action: 'fill_login',
      outcome: 'filled',
      approval: 'once',
    });
    const log = await call(alice, 'GET', '/log');
    expect(log.json.entries).toEqual([
      expect.objectContaining({
        item_label: 'GitHub',
        origin: 'https://github.com',
        action: 'fill_login',
        approval: 'once',
      }),
    ]);
    expect((await call(bob, 'GET', '/log')).json.entries).toEqual([]);
  });
});

describe('service helpers', () => {
  it('matches entries to a page origin (exact and explicit wildcard only)', async () => {
    await call(alice, 'POST', '', GITHUB);
    await call(alice, 'POST', '', { label: 'Other', origins: ['https://gitlab.com'], password: 'x' });
    expect((await vaultMatchesForOrigin(db, alice.id, 'https://github.com')).map((m) => m.label)).toEqual(['GitHub']);
    expect((await vaultMatchesForOrigin(db, alice.id, 'https://gist.github.com')).map((m) => m.label)).toEqual([
      'GitHub',
    ]);
    expect(await vaultMatchesForOrigin(db, alice.id, 'https://github.com.evil.com')).toEqual([]);
    expect(await vaultMatchesForOrigin(db, bob.id, 'https://github.com')).toEqual([]);
  });

  it('saves a secure sign-in once and updates it when the password changes', async () => {
    const first = await saveSecureLogin(db, alice.id, 'https://example.com', { username: 'a@x.com', password: 'one' });
    const second = await saveSecureLogin(db, alice.id, 'https://example.com', { username: 'a@x.com', password: 'two' });
    expect(second!.id).toBe(first!.id);
    expect(first).toMatchObject({ label: 'example.com', origins: ['https://example.com'] });
    const row = (await db.vault.get(alice.id, first!.id))!;
    expect(revealVaultSecrets(alice.id, row, ['password'])).toEqual({ password: 'two' });
    const otherUser = await saveSecureLogin(db, alice.id, 'https://example.com', {
      username: 'b@x.com',
      password: 'b',
    });
    expect(otherUser!.id).not.toBe(first!.id);
    expect(await saveSecureLogin(db, alice.id, 'https://example.com', { otp: '123456' })).toBeNull();
  });
});
