/**
 * Feishu / WeCom login state in `login_states` (real PostgreSQL).
 *
 * Only the SHA-256 of a value is stored, a value is consumed at most once, and
 * provider, kind and expiry all gate the consume. The cross-connection race is
 * pinned in security-state.db-commit.test.ts.
 */

import { safeJsonParse } from '@greenhouse/utils/json';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { _resetProvider, initDatabase, type DatabaseProvider } from '../index.js';
import { TEST_DATABASE_URL } from '../test-config.js';

let db: DatabaseProvider;
const value = () => randomBytes(32).toString('base64url');
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

describe('oauthLoginStates', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('stores only the SHA-256 of the value, never the value itself', async () => {
    const state = value();
    await db.oauthLoginStates.issue({
      value: state,
      provider: 'feishu',
      kind: 'pending',
      payload: { intent: 'login' },
      expiresAt: inMinutes(10),
    });
    const hash = createHash('sha256').update(state).digest('hex');
    const rows = (await db.executeRaw(
      sql`SELECT id, payload FROM login_states WHERE id IN (${hash}, ${state})`,
    )) as Array<{ id: string; payload: unknown }>;
    expect(rows.map((row) => ({ id: row.id, payload: safeJsonParse(row.payload, null) }))).toEqual([
      { id: hash, payload: { intent: 'login' } },
    ]);
  });

  it('consumes a value exactly once and returns its payload', async () => {
    const code = value();
    await db.oauthLoginStates.issue({
      value: code,
      provider: 'feishu',
      kind: 'login_code',
      payload: { userId: 'u-1' },
      expiresAt: inMinutes(1),
    });
    expect(await db.oauthLoginStates.consume({ value: code, provider: 'feishu', kind: 'login_code' })).toEqual({
      userId: 'u-1',
    });
    expect(await db.oauthLoginStates.consume({ value: code, provider: 'feishu', kind: 'login_code' })).toBeNull();
  });

  it('only one of two concurrent consumers wins', async () => {
    const state = value();
    await db.oauthLoginStates.issue({
      value: state,
      provider: 'wecom',
      kind: 'pending',
      payload: { userId: 'u-2' },
      expiresAt: inMinutes(10),
    });
    const results = await Promise.all([
      db.oauthLoginStates.consume({ value: state, provider: 'wecom', kind: 'pending' }),
      db.oauthLoginStates.consume({ value: state, provider: 'wecom', kind: 'pending' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses another provider, another kind, an unknown value and an expired one — without burning a valid one', async () => {
    const state = value();
    await db.oauthLoginStates.issue({
      value: state,
      provider: 'feishu',
      kind: 'pending',
      payload: { intent: 'bind', userId: 'u-3' },
      expiresAt: inMinutes(10),
    });
    expect(await db.oauthLoginStates.consume({ value: state, provider: 'wecom', kind: 'pending' })).toBeNull();
    expect(await db.oauthLoginStates.consume({ value: state, provider: 'feishu', kind: 'login_code' })).toBeNull();
    expect(await db.oauthLoginStates.consume({ value: value(), provider: 'feishu', kind: 'pending' })).toBeNull();
    // The mismatched attempts above did not use it up.
    expect(await db.oauthLoginStates.consume({ value: state, provider: 'feishu', kind: 'pending' })).toMatchObject({
      intent: 'bind',
    });

    const stale = value();
    await db.oauthLoginStates.issue({
      value: stale,
      provider: 'feishu',
      kind: 'pending',
      payload: {},
      expiresAt: inMinutes(-1),
    });
    expect(await db.oauthLoginStates.consume({ value: stale, provider: 'feishu', kind: 'pending' })).toBeNull();
  });

  it('sweeps expired rows, used or not, and keeps live ones', async () => {
    const stale = value();
    const live = value();
    await db.oauthLoginStates.issue({
      value: stale,
      provider: 'feishu',
      kind: 'pending',
      payload: {},
      expiresAt: inMinutes(-5),
    });
    await db.oauthLoginStates.issue({
      value: live,
      provider: 'feishu',
      kind: 'pending',
      payload: {},
      expiresAt: inMinutes(5),
    });
    expect(await db.oauthLoginStates.sweepExpired()).toBeGreaterThanOrEqual(1);
    const ids = [stale, live].map((v) => createHash('sha256').update(v).digest('hex'));
    const rows = (await db.executeRaw(
      sql`SELECT id FROM login_states WHERE id IN (${ids[0]}, ${ids[1]})`,
    )) as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toEqual([ids[1]]);
  });
});
