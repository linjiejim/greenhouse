/**
 * Vault service + /api/bots/vault routes on real PostgreSQL: secrets are
 * write-only (never in a response, ciphertext at rest bound to its row), and
 * every route is owner-scoped (another member's entry is a 404).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  _resetProvider,
  initDatabase,
  newVaultItemId,
  type DatabaseProvider,
  type UserRow,
  type VaultItemInsert,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { VaultItemView } from '@greenhouse/types/bots';
import { encrypt } from '@greenhouse/utils/crypto';
import type { AppEnv } from '../../../app-env.js';
import { createBotsVaultRoutes } from '../routes.js';
import { recordVaultAccess, revealVaultSecrets, saveSecureLogin, vaultMatchesForOrigin } from '../service.js';
import { encryptVaultField, isCurrentVaultCiphertext, vaultAad } from '../crypto.js';
import { rekeyVault } from '../rekey.js';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';

const KEY = 'f6'.repeat(32);
const originalKey = process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
const originalVaultKeys = [process.env.VAULT_ENCRYPTION_KEY, process.env.VAULT_ENCRYPTION_KEY_PREVIOUS];
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
  const [vaultKey, previousKey] = originalVaultKeys;
  if (vaultKey === undefined) delete process.env.VAULT_ENCRYPTION_KEY;
  else process.env.VAULT_ENCRYPTION_KEY = vaultKey;
  if (previousKey === undefined) delete process.env.VAULT_ENCRYPTION_KEY_PREVIOUS;
  else process.env.VAULT_ENCRYPTION_KEY_PREVIOUS = previousKey;
});

beforeEach(async () => {
  process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = KEY;
  delete process.env.VAULT_ENCRYPTION_KEY;
  delete process.env.VAULT_ENCRYPTION_KEY_PREVIOUS;
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

describe('rotating the key (pnpm cli vault rekey)', () => {
  const NEW_KEY = '0d'.repeat(32);
  const COLUMNS = ['username_enc', 'password_enc', 'totp_enc'] as const;
  const entry = (id: string, password_enc: string): VaultItemInsert => ({
    id,
    user_id: bob.id,
    label: id,
    origins: ['https://legacy.example'],
    username_enc: null,
    username_hint: '',
    password_enc,
    totp_enc: null,
    policy: 'ask',
  });

  it('puts every entry under the new key — ones from before the version prefix too — and they still fill', async () => {
    // Alice's entry was written while the vault used the provider key; Bob's predates the version prefix.
    const github = (await call(alice, 'POST', '', GITHUB)).json.item as VaultItemView;
    const legacyId = newVaultItemId();
    const legacy = encrypt('old secret', Buffer.from(KEY, 'hex'), vaultAad(bob.id, legacyId, 'password'));
    await db.vault.create(entry(legacyId, legacy));
    // And one written with a key this deployment no longer has.
    const lostId = newVaultItemId();
    process.env.VAULT_ENCRYPTION_KEY = 'ee'.repeat(32);
    const lost = encryptVaultField(bob.id, lostId, 'password', 'gone');
    delete process.env.VAULT_ENCRYPTION_KEY;
    await db.vault.create(entry(lostId, lost));

    const before = (await db.vault.get(alice.id, github.id))!;
    const secrets = revealVaultSecrets(alice.id, before, ['username', 'password', 'totp']);
    process.env.VAULT_ENCRYPTION_KEY = NEW_KEY;

    const dry = await rekeyVault(db, { dryRun: true });
    expect(dry.rekeyed).toBeGreaterThanOrEqual(2);
    expect(await db.vault.get(alice.id, github.id)).toEqual(before);

    const result = await rekeyVault(db);
    expect(result.changed).toBe(0);
    expect(result.unreadable).toContainEqual({ id: lostId, user_id: bob.id });
    const after = (await db.vault.get(alice.id, github.id))!;
    expect(COLUMNS.every((column) => isCurrentVaultCiphertext(after[column]!))).toBe(true);
    expect(after.updated_at).toBe(before.updated_at); // not an edit
    const moved = (await db.vault.get(bob.id, legacyId))!;
    expect(isCurrentVaultCiphertext(moved.password_enc!)).toBe(true);
    expect((await db.vault.get(bob.id, lostId))!.password_enc).toBe(lost);

    // Under the vault's own key now: the provider key is no longer needed to read them.
    delete process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
    expect(revealVaultSecrets(alice.id, after, ['username', 'password', 'totp'])).toEqual(secrets);
    expect(revealVaultSecrets(bob.id, moved, ['password'])).toEqual({ password: 'old secret' });
    expect(await rekeyVault(db)).toMatchObject({ rekeyed: 0, changed: 0 });
  });

  it('never undoes an edit its member makes while it runs', async () => {
    const github = (await call(alice, 'POST', '', GITHUB)).json.item as VaultItemView;
    process.env.VAULT_ENCRYPTION_KEY = NEW_KEY;
    // The password changes between the rekey reading the entries and writing them back.
    const racing = {
      vault: {
        ...db.vault,
        listAll: async () => {
          const rows = await db.vault.listAll();
          await call(alice, 'PATCH', `/${github.id}`, { password: 'edited meanwhile' });
          return rows;
        },
      },
    };
    expect(await rekeyVault(racing)).toMatchObject({ changed: 1 });
    const row = (await db.vault.get(alice.id, github.id))!;
    expect(revealVaultSecrets(alice.id, row, ['password'])).toEqual({ password: 'edited meanwhile' });
    expect(isCurrentVaultCiphertext(row.username_enc!)).toBe(false); // left for the next run

    expect(await rekeyVault(db)).toMatchObject({ changed: 0 });
    const done = (await db.vault.get(alice.id, github.id))!;
    expect(COLUMNS.every((column) => isCurrentVaultCiphertext(done[column]!))).toBe(true);
    expect(revealVaultSecrets(alice.id, done, ['username', 'password'])).toEqual({
      username: GITHUB.username,
      password: 'edited meanwhile',
    });
  });
});
