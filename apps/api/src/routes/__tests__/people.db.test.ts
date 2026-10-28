/**
 * Member names for plugin record fields (`POST /api/people/resolve`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { initDatabase, _resetProvider, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import peopleRoutes, { MAX_RESOLVE_PEOPLE } from '../people.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let ada: UserRow;
let bo: UserRow;

function app(actor: Pick<UserRow, 'id' | 'email' | 'role'>) {
  return new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('user', { id: actor.id, email: actor.email, role: actor.role } as never);
      await next();
    })
    .route('/api/people', peopleRoutes);
}

const resolve = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('people resolve', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    const tag = randomBytes(4).toString('hex');
    ada = await createInternalTestUser(db, { email: `ada_${tag}@example.test`, nickname: 'Ada' });
    bo = await createInternalTestUser(db, { email: `bo_${tag}@example.test`, nickname: 'Bo' });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('answers names only for the ids asked, never emails or roles', async () => {
    const res = await app(ada).request('/api/people/resolve', resolve({ ids: [bo.id, 'usr_missing'] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ people: [{ id: bo.id, name: 'Bo' }] });
  });

  it('is for internal members only', async () => {
    const res = await app({ ...ada, role: 'external' }).request('/api/people/resolve', resolve({ ids: [bo.id] }));
    expect(res.status).toBe(403);
  });

  it('rejects malformed or oversized batches', async () => {
    const server = app(ada);
    expect((await server.request('/api/people/resolve', resolve({ ids: 'x' }))).status).toBe(400);
    const many = Array.from({ length: MAX_RESOLVE_PEOPLE + 1 }, (_, i) => `usr_${i}`);
    expect((await server.request('/api/people/resolve', resolve({ ids: many }))).status).toBe(400);
  });
});
