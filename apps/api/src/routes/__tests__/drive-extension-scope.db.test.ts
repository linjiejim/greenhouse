/**
 * An extension's own drive scope, through the real route.
 *
 * The point of the seam is that core validates the shape and delegates the
 * rule: a scope nobody registered is rejected at the edge, a registered one is
 * authorized by the extension's resolver, and the database's own constraint
 * catches a row that mixes an extension scope with core's owner columns.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { initDatabase, _resetProvider, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import drive from '../drive.js';
import { registerDriveScopes, _resetExtensionDriveScopes, type DriveAccess } from '../../drive/access.js';
import type { AppEnv } from '../../app-env.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let user: Awaited<ReturnType<typeof createInternalTestUser>>;

/** Owner "7" is the caller's; everything else is somebody else's. */
const OWNED = '7';

function app() {
  return new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('user', { id: user.id, role: 'team', email: user.email, name: 'Test' } as never);
      await next();
    })
    .route('/api/drive', drive);
}

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  user = await createInternalTestUser(db, { email: `drive-scope-${Date.now()}@test.local`, role: 'team' });
  _resetExtensionDriveScopes();
  registerDriveScopes([
    {
      scope: 'probe-scope',
      authorize: async (ownerKey): Promise<DriveAccess> => (ownerKey === OWNED ? 'editor' : null),
    },
  ]);
});

afterEach(async () => {
  _resetExtensionDriveScopes();
  await db.close();
  _resetProvider();
});

describe('extension drive scope', () => {
  it('creates and lists under the extension owner key', async () => {
    const created = await app().request('/api/drive/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'probe-scope', owner_key: OWNED, name: 'Attachments' }),
    });
    expect(created.status).toBe(200);
    const { folder } = (await created.json()) as { folder: Record<string, unknown> };
    // The row carries the extension's key and none of core's owner columns.
    expect(folder).toMatchObject({ scope: 'probe-scope', owner_key: OWNED, base_id: null, visibility: null });

    const listed = await app().request(`/api/drive/folders?scope=probe-scope&owner_key=${OWNED}`);
    expect(listed.status).toBe(200);
    const { folders } = (await listed.json()) as { folders: Array<{ name: string }> };
    expect(folders.map((f) => f.name)).toEqual(['Attachments']);
  });

  it('denies another owner, an absent key, and a scope nobody registered', async () => {
    const foreign = await app().request('/api/drive/folders?scope=probe-scope&owner_key=999');
    expect(foreign.status).toBe(403);

    const noKey = await app().request('/api/drive/folders?scope=probe-scope');
    expect(noKey.status).toBe(400);

    const unknown = await app().request('/api/drive/folders?scope=nobody-registered-this&owner_key=1');
    expect(unknown.status).toBe(400);
  });

  it('cannot list an extension scope through core owner keys', async () => {
    // `scope=probe-scope&visibility=team` must not fall back to the kb lane.
    const res = await app().request('/api/drive/folders?scope=probe-scope&visibility=team');
    expect(res.status).toBe(400);
  });
});
