/**
 * /api/drive file rename / move and the knowledge-cabinet name search, through
 * the real route: both ends of a move are authorized, a move never crosses
 * cabinets, and search only returns what the caller may read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { initDatabase, _resetProvider, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import drive from '../drive.js';
import type { AppEnv } from '../../app-env.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let alice: UserRow;
let bob: UserRow;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function app(user: UserRow) {
  return new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('user', { id: user.id, role: 'team', email: user.email, name: 'Test' } as never);
      await next();
    })
    .route('/api/drive', drive);
}

async function activeFile(owner: UserRow, visibility: 'team' | 'private', folderId: string | null = null) {
  const row = await db.drive.initFile({
    scope: 'kb',
    folder_id: folderId,
    name: `${unique('doc')}.txt`,
    cos_key: `drive/test/${unique('k')}.txt`,
    size: 3,
    visibility,
    owner_user_id: visibility === 'private' ? owner.id : null,
    uploaded_by: owner.id,
  });
  return (await db.drive.completeFile(row.id, { size: 3 }))!;
}

const put = (user: UserRow, id: string, body: unknown) =>
  app(user).request(`/api/drive/files/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  alice = await createInternalTestUser(db, { email: `${unique('df-alice')}@test.local` });
  bob = await createInternalTestUser(db, { email: `${unique('df-bob')}@test.local` });
});

afterEach(async () => {
  await db.close();
  _resetProvider();
});

describe('drive file rename and move', () => {
  it('renames a team file for any member and refuses a blocked extension', async () => {
    const file = await activeFile(alice, 'team');
    const renamed = await put(bob, file.id, { name: 'plan.txt' });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { file: { name: string } }).file.name).toBe('plan.txt');

    const blocked = await put(bob, file.id, { name: 'plan.html' });
    expect(blocked.status).toBe(400);
  });

  it("refuses someone else's personal file and a move into another cabinet", async () => {
    const personal = await activeFile(alice, 'private');
    expect((await put(bob, personal.id, { name: 'mine.txt' })).status).toBe(403);

    const teamFolder = await db.drive.createFolder({ scope: 'kb', name: unique('Team'), visibility: 'team' });
    const crossed = await put(alice, personal.id, { folder_id: teamFolder.id });
    expect(crossed.status).toBe(400);

    const ownFolder = await db.drive.createFolder({
      scope: 'kb',
      name: unique('Mine'),
      visibility: 'private',
      owner_user_id: alice.id,
    });
    const moved = await put(alice, personal.id, { folder_id: ownFolder.id });
    expect(moved.status).toBe(200);
    expect((await db.drive.getFile(personal.id))?.folder_id).toBe(ownFolder.id);
  });

  it('refuses to start an upload into a folder of another cabinet', async () => {
    const privateFolder = await db.drive.createFolder({
      scope: 'kb',
      name: unique('Private'),
      visibility: 'private',
      owner_user_id: alice.id,
    });
    const res = await app(bob).request('/api/drive/files/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'kb', visibility: 'team', folder_id: privateFolder.id, name: 'a.txt', size: 1 }),
    });
    expect(res.status).toBe(404);
  });
});

describe('drive search', () => {
  it('finds team files and my own, never another member’s personal files', async () => {
    const marker = unique('needle');
    const team = await db.drive.initFile({
      scope: 'kb',
      name: `${marker}-team.txt`,
      cos_key: `drive/test/${unique('k')}`,
      visibility: 'team',
      uploaded_by: alice.id,
    });
    await db.drive.completeFile(team.id, { size: 1 });
    const hidden = await db.drive.initFile({
      scope: 'kb',
      name: `${marker}-alice.txt`,
      cos_key: `drive/test/${unique('k')}`,
      visibility: 'private',
      owner_user_id: alice.id,
      uploaded_by: alice.id,
    });
    await db.drive.completeFile(hidden.id, { size: 1 });

    const res = await app(bob).request(`/api/drive/search?q=${encodeURIComponent(marker)}`);
    expect(res.status).toBe(200);
    const { files } = (await res.json()) as { files: Array<{ id: string }> };
    expect(files.map((f) => f.id)).toEqual([team.id]);

    const own = (await (await app(alice).request(`/api/drive/search?q=${marker}`)).json()) as {
      files: Array<{ id: string }>;
    };
    expect(own.files.map((f) => f.id).sort()).toEqual([team.id, hidden.id].sort());
  });
});
