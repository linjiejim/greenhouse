/**
 * MCP connectors: slugs are unique per scope and owner; a member's credential
 * lives in provider_connections under `mcp:<connector id>`; changing the
 * address / auth scheme (dropCredentials) or deleting the connector drops every
 * member credential in the same transaction; refreshes are compare-and-set.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetProvider,
  initDatabase,
  mcpConnectionProvider,
  type DatabaseProvider,
  type UserRow,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;
let alice: UserRow;
let bob: UserRow;

const unique = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const slug = () => `c${Math.random().toString(36).slice(2, 10)}`;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  alice = await createInternalTestUser(db, { email: `${unique('mcp-a')}@test.local` });
  bob = await createInternalTestUser(db, { email: `${unique('mcp-b')}@test.local` });
});

afterEach(async () => {
  await db.close();
  _resetProvider();
});

function team(overrides: Partial<Parameters<DatabaseProvider['mcpConnectors']['create']>[0]> = {}) {
  return db.mcpConnectors.create({
    scope: 'team',
    slug: slug(),
    name: 'Tickets',
    url: 'https://mcp.example.com/mcp',
    auth_mode: 'per_member',
    auth_kind: 'key',
    auth_header: 'Authorization',
    ...overrides,
  });
}

describe('mcp connectors', () => {
  it('creates team and personal connectors with mcc ids; a slug is unique per scope and owner', async () => {
    const s = slug();
    const row = await team({ slug: s });
    expect(row.id).toMatch(/^mcc/);
    expect(row.owner_user_id).toBeNull();
    // The same slug as a personal connector, for two different people, is fine.
    const mine = await db.mcpConnectors.create({
      scope: 'personal',
      owner_user_id: alice.id,
      slug: s,
      name: 'Mine',
      url: 'https://x.example.com/mcp',
    });
    await db.mcpConnectors.create({
      scope: 'personal',
      owner_user_id: bob.id,
      slug: s,
      name: 'Theirs',
      url: 'https://x.example.com/mcp',
    });
    expect(mine.scope).toBe('personal');
    expect((await db.mcpConnectors.listPersonal(alice.id)).map((r) => r.id)).toContain(mine.id);
    expect((await db.mcpConnectors.listPersonal(bob.id)).map((r) => r.id)).not.toContain(mine.id);
    // Last: a constraint violation aborts the test transaction.
    await expect(team({ slug: s })).rejects.toThrow();
  });

  it('refuses a personal connector with a shared credential', async () => {
    await expect(
      db.mcpConnectors.create({
        scope: 'personal',
        owner_user_id: alice.id,
        slug: slug(),
        name: 'x',
        url: 'https://x.example.com',
        auth_mode: 'shared',
      }),
    ).rejects.toThrow();
  });

  it('refuses a personal connector into the private network', async () => {
    await expect(
      db.mcpConnectors.create({
        scope: 'personal',
        owner_user_id: alice.id,
        slug: slug(),
        name: 'x',
        url: 'https://x.example.com',
        private_network: true,
      }),
    ).rejects.toThrow();
  });

  it('stores a member credential under mcp:<id>, and an address change drops every one in the same write', async () => {
    const row = await team();
    await db.mcpConnectors.saveConnection(alice.id, row.id, { credential: 'sealed-a' });
    await db.mcpConnectors.saveConnection(bob.id, row.id, { credential: 'sealed-b' });
    const conn = await db.mcpConnectors.getConnection(alice.id, row.id);
    expect(conn?.provider).toBe(mcpConnectionProvider(row.id));
    expect(conn?.metadata).toMatchObject({ status: 'active', last_error: null });
    expect((await db.mcpConnectors.countConnections([row.id])).get(row.id)).toBe(2);

    // A rename keeps them …
    await db.mcpConnectors.update(row.id, { name: 'Renamed' });
    expect((await db.mcpConnectors.countConnections([row.id])).get(row.id)).toBe(2);
    // … a new address does not.
    const updated = await db.mcpConnectors.update(
      row.id,
      { url: 'https://other.example.com/mcp' },
      { dropCredentials: true },
    );
    expect(updated?.url).toBe('https://other.example.com/mcp');
    expect(await db.mcpConnectors.getConnection(alice.id, row.id)).toBeUndefined();
    expect(await db.mcpConnectors.getConnection(bob.id, row.id)).toBeUndefined();
  });

  it('deleting a connector deletes its member credentials, and only its own', async () => {
    const a = await team();
    const b = await team();
    await db.mcpConnectors.saveConnection(alice.id, a.id, { credential: 'x' });
    await db.mcpConnectors.saveConnection(alice.id, b.id, { credential: 'y' });
    await db.mcpConnectors.delete(a.id);
    expect(await db.mcpConnectors.getById(a.id)).toBeUndefined();
    expect(await db.mcpConnectors.getConnection(alice.id, a.id)).toBeUndefined();
    expect(await db.mcpConnectors.getConnection(alice.id, b.id)).toBeDefined();
  });

  it('a refresh only overwrites the tokens it read; an expiry only marks the sign-in that failed', async () => {
    const row = await team({ auth_kind: 'oauth', auth_header: null });
    await db.mcpConnectors.saveConnection(alice.id, row.id, { access_token: 'a1', refresh_token: 'r1' });
    expect(
      await db.mcpConnectors.updateConnectionTokens(alice.id, row.id, 'a1', {
        access_token: 'a2',
        refresh_token: 'r2',
      }),
    ).toBe(true);
    // A second request that read a1 lost the race: its write is refused, r2 survives.
    expect(
      await db.mcpConnectors.updateConnectionTokens(alice.id, row.id, 'a1', {
        access_token: 'a3',
        refresh_token: 'stale',
      }),
    ).toBe(false);
    const conn = await db.mcpConnectors.getConnection(alice.id, row.id);
    expect(conn).toMatchObject({ access_token_enc: 'a2', refresh_token_enc: 'r2' });

    await db.mcpConnectors.expireConnection(alice.id, row.id, 'a1', 'old');
    expect((await db.mcpConnectors.getConnection(alice.id, row.id))?.metadata).toMatchObject({ status: 'active' });
    await db.mcpConnectors.expireConnection(alice.id, row.id, 'a2', 'refused');
    expect((await db.mcpConnectors.getConnection(alice.id, row.id))?.metadata).toMatchObject({
      status: 'needs_reauth',
      last_error: 'refused',
    });
  });

  it('the shared secret is compare-and-set when a refresh names what it read', async () => {
    const row = await team({ auth_mode: 'shared', auth_kind: 'oauth', auth_header: null, shared_secret_enc: 's1' });
    expect(await db.mcpConnectors.setSharedSecret(row.id, 's2', 's1')).toBe(true);
    expect(await db.mcpConnectors.setSharedSecret(row.id, 's3', 's1')).toBe(false);
    expect((await db.mcpConnectors.getById(row.id))?.shared_secret_enc).toBe('s2');
  });

  it('a failed refresh keeps the last tool list and records why; listEnabled skips disabled connectors', async () => {
    const row = await team();
    const tools = [
      { name: 'lookup', description: 'Look up', input_schema: { type: 'object' }, read_only: true, destructive: false },
    ];
    await db.mcpConnectors.recordRefresh(row.id, { ok: true, tools });
    const failed = await db.mcpConnectors.recordRefresh(row.id, { ok: false, error: 'down' });
    expect(failed?.tools).toEqual(tools);
    expect(failed?.last_error).toBe('down');
    await db.mcpConnectors.update(row.id, { enabled: false });
    expect((await db.mcpConnectors.listEnabled()).map((r) => r.id)).not.toContain(row.id);
  });
});
