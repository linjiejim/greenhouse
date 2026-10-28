/**
 * Shared security state across connections (rate-limit counters, OAuth login state).
 *
 * @db-commit-reason "Shared" means visible to a second instance and surviving a
 * restart: the cases below use two independent providers (two connection pools)
 * over committed rows, which a per-test rollback transaction would hide.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { isolatedDatabase } from '../helpers/isolated-db.js';
let fixture: Awaited<ReturnType<typeof isolatedDatabase>>;

const run = randomUUID();
let instanceA: DatabaseProvider;
let instanceB: DatabaseProvider;
const expiresAt = () => new Date(Date.now() + 60_000).toISOString();

describe('security state shared between instances', () => {
  beforeAll(async () => {
    fixture = await isolatedDatabase('security_state');
    instanceA = createDatabase(fixture.url);
    instanceB = createDatabase(fixture.url);
  }, 30_000);

  afterAll(async () => {
    // Close both replicas before dropping their owned database.
    await instanceA.close();
    await instanceB.close();
    await fixture?.drop();
  }, 30_000);

  it('counts concurrent hits from two instances exactly once each', async () => {
    const key = `commit:rate:${run}`;
    const counts = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? instanceA : instanceB).rateLimits.hit(key, expiresAt())),
    );
    expect([...counts].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('keeps a counter across a restart (a brand-new pool sees it)', async () => {
    const key = `commit:restart:${run}`;
    await instanceA.rateLimits.hit(key, expiresAt());
    const restarted = createDatabase(fixture.url);
    try {
      expect(await restarted.rateLimits.hit(key, expiresAt())).toBe(2);
    } finally {
      await restarted.close();
    }
  });

  it('lets exactly one of two instances consume a login state', async () => {
    const state = randomBytes(32).toString('base64url');
    await instanceA.oauthLoginStates.issue({
      value: state,
      provider: 'feishu',
      kind: 'pending',
      payload: { intent: 'login' },
      expiresAt: expiresAt(),
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        (i % 2 ? instanceA : instanceB).oauthLoginStates.consume({ value: state, provider: 'feishu', kind: 'pending' }),
      ),
    );
    expect(results.filter(Boolean)).toEqual([{ intent: 'login' }]);
  });
});
