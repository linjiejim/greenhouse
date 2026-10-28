/**
 * Model gateway keys: only the SHA-256 of a secret is stored and a lookup
 * hashes the presented secret; revoking stamps the row (first revocation wins,
 * owner-scoped when asked); expiry and revocation make a key unusable; the
 * use stamp is throttled to once a minute.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, gatewayKeyAllowedModels, gatewayKeyUsability, hashGatewaySecret, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let other: UserRow;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function secret(): string {
  return `ghgw_${unique('secret')}_abcdefghijklmnopqrstuvwxyz`;
}

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  owner = await createInternalTestUser(db, { email: `${unique('gw-owner')}@test.local` });
  other = await createInternalTestUser(db, { email: `${unique('gw-other')}@test.local` });
});

afterEach(async () => {
  await db.close();
  _resetProvider();
});

describe('gateway keys', () => {
  it('stores only the hash and a short prefix, and finds the key by its secret', async () => {
    const raw = secret();
    const row = await db.gatewayKeys.create({ user_id: owner.id, name: 'laptop', secret: raw });
    expect(row.id).toMatch(/^gwk_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(row.key_hash).toBe(hashGatewaySecret(raw));
    expect(row.key_hash).not.toContain(raw);
    expect(row.key_prefix).toBe(raw.slice(0, 12));
    expect(JSON.stringify(row)).not.toContain(raw);

    expect((await db.gatewayKeys.findBySecret(raw))?.id).toBe(row.id);
    expect(await db.gatewayKeys.findBySecret(`${raw}x`)).toBeNull();
    expect(await db.gatewayKeys.findBySecret(row.key_hash)).toBeNull();
  });

  it('keeps a model allow-list, or null for every model', async () => {
    const all = await db.gatewayKeys.create({ user_id: owner.id, name: 'all', secret: secret() });
    const some = await db.gatewayKeys.create({
      user_id: owner.id,
      name: 'some',
      secret: secret(),
      allowed_models: ['flash', 'flash', 'pro'],
    });
    const empty = await db.gatewayKeys.create({
      user_id: owner.id,
      name: 'empty',
      secret: secret(),
      allowed_models: [],
    });
    expect(gatewayKeyAllowedModels(all)).toBeNull();
    expect(gatewayKeyAllowedModels(some)).toEqual(['flash', 'pro']);
    expect(gatewayKeyAllowedModels(empty)).toBeNull();
    expect(gatewayKeyAllowedModels({ allowed_models: 'not json' })).toEqual([]);
  });

  it('revokes: owner-scoped, first revocation wins, the key stops being usable', async () => {
    const raw = secret();
    const row = await db.gatewayKeys.create({ user_id: owner.id, name: 'ci', secret: raw });
    expect(gatewayKeyUsability(row)).toBe('active');

    expect(await db.gatewayKeys.revoke({ id: row.id, user_id: other.id, revoked_by: other.id })).toBeNull();
    const first = await db.gatewayKeys.revoke({
      id: row.id,
      user_id: owner.id,
      revoked_by: owner.id,
      at: '2026-10-01T00:00:00.000Z',
    });
    expect(first?.changed).toBe(true);
    const again = await db.gatewayKeys.revoke({ id: row.id, revoked_by: other.id });
    expect(again?.changed).toBe(false);
    expect(again?.row.revoked_by).toBe(owner.id);
    expect(Date.parse(again!.row.revoked_at!)).toBe(Date.parse('2026-10-01T00:00:00.000Z'));

    const found = await db.gatewayKeys.findBySecret(raw);
    expect(found && gatewayKeyUsability(found)).toBe('revoked');
    expect(await db.gatewayKeys.revoke({ id: 'gwk_missing', revoked_by: owner.id })).toBeNull();
  });

  it('expires', async () => {
    const now = Date.parse('2026-10-24T12:00:00.000Z');
    const row = await db.gatewayKeys.create({
      user_id: owner.id,
      name: 'short',
      secret: secret(),
      expires_at: '2026-10-25T00:00:00.000Z',
    });
    expect(gatewayKeyUsability(row, now)).toBe('active');
    expect(gatewayKeyUsability(row, Date.parse('2026-10-25T00:00:00.000Z'))).toBe('expired');
  });

  it('counts only usable keys and lists a member’s own, newest first', async () => {
    const a = await db.gatewayKeys.create({
      user_id: owner.id,
      name: 'a',
      secret: secret(),
      at: '2026-10-01T00:00:00.000Z',
    });
    await db.gatewayKeys.create({ user_id: owner.id, name: 'b', secret: secret(), at: '2026-10-02T00:00:00.000Z' });
    await db.gatewayKeys.create({
      user_id: owner.id,
      name: 'old',
      secret: secret(),
      expires_at: '2026-10-03T00:00:00.000Z',
      at: '2026-09-30T00:00:00.000Z',
    });
    await db.gatewayKeys.create({ user_id: other.id, name: 'theirs', secret: secret() });
    await db.gatewayKeys.revoke({ id: a.id, revoked_by: owner.id });

    expect(await db.gatewayKeys.countActiveByUser(owner.id, '2026-10-24T00:00:00.000Z')).toBe(1);
    expect((await db.gatewayKeys.listByUser(owner.id)).map((row) => row.name)).toEqual(['b', 'a', 'old']);
    const all = await db.gatewayKeys.listAll();
    const theirs = all.find((row) => row.name === 'theirs' && row.user_id === other.id);
    expect(theirs?.owner_email).toBe(other.email);
  });

  it('stamps use at most once a minute', async () => {
    const row = await db.gatewayKeys.create({ user_id: owner.id, name: 'use', secret: secret() });
    await db.gatewayKeys.touchLastUsed(row.id, '2026-10-24T12:00:00.000Z');
    await db.gatewayKeys.touchLastUsed(row.id, '2026-10-24T12:00:30.000Z');
    expect(Date.parse((await db.gatewayKeys.getById(row.id))!.last_used_at!)).toBe(
      Date.parse('2026-10-24T12:00:00.000Z'),
    );
    await db.gatewayKeys.touchLastUsed(row.id, '2026-10-24T12:01:01.000Z');
    expect(Date.parse((await db.gatewayKeys.getById(row.id))!.last_used_at!)).toBe(
      Date.parse('2026-10-24T12:01:01.000Z'),
    );
  });
});
