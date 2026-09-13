/** Cost/value route authorization and query validation (real PostgreSQL). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import { requireSuper } from '../../auth/middleware.js';
import costValueRoutes from '../cost-value.js';

let db: DatabaseProvider;
let superUser: UserRow;
let teamUser: UserRow;

async function createUser(role: 'team' | 'super'): Promise<UserRow> {
  const unique = `${Date.now()}-${Math.random()}`;
  return db.users.create({
    email: `cost-value-${role}-${unique}@test.local`,
    password_hash: 'hash',
    nickname: `cost-value-${role}`,
    role,
  });
}

function createApp(user: UserRow) {
  return new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('user', { id: user.id, role: user.role });
      return next();
    })
    .use('/api/admin/*', requireSuper())
    .route('/api/admin/operations', costValueRoutes);
}

describe('GET /api/admin/operations/cost-value', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    superUser = await createUser('super');
    teamUser = await createUser('team');
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('is super-only and never returns a synthetic token cost', async () => {
    expect((await createApp(teamUser).request('/api/admin/operations/cost-value')).status).toBe(403);

    const response = await createApp(superUser).request('/api/admin/operations/cost-value');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      accounting: { token_cost_estimate: number | null; token_cost_estimate_reason: string };
    };
    expect(body.accounting).toEqual(
      expect.objectContaining({
        token_cost_estimate: null,
        token_cost_estimate_reason: 'provider_prices_unavailable',
      }),
    );
  });

  it('rejects malformed and unbounded report windows', async () => {
    const invalid = await createApp(superUser).request('/api/admin/operations/cost-value?since=nope');
    expect(invalid.status).toBe(400);

    const tooWide = await createApp(superUser).request(
      '/api/admin/operations/cost-value?since=2020-01-01T00%3A00%3A00.000Z&until=2026-01-02T00%3A00%3A00.000Z',
    );
    expect(tooWide.status).toBe(400);
  });
});
