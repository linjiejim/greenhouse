/**
 * A Bot's screenshot of the member's signed-in browser, against real
 * PostgreSQL and the real chat-files download route: only the owner of the
 * Bots conversation can open it — not another member, not a super — and its
 * URL is not under the public upload path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../../app-env.js';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';

// Object storage in memory: the property under test is who may read the row.
const objects = vi.hoisted(() => new Map<string, { buffer: Buffer; contentType: string }>());
vi.mock('../../../storage/uploads.js', () => ({
  putObjectAtKey: vi.fn(async (key: string, buffer: Buffer, contentType: string) => {
    objects.set(key, { buffer, contentType });
  }),
  getObjectAtKey: vi.fn(async (key: string) => objects.get(key) ?? null),
  deleteObjectAtKey: vi.fn(async (key: string) => {
    objects.delete(key);
  }),
  presignGetUrl: vi.fn(async () => null),
  presignPutUrl: vi.fn(async () => null),
  headObjectSize: vi.fn(async () => null),
  putUpload: vi.fn(async () => {
    throw new Error('screenshots must not go to the public upload store');
  }),
}));

const { storeScreenshotAsChatFile } = await import('../browser-session.js');
const { default: chatFiles } = await import('../../../routes/chat-files.js');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

let db: DatabaseProvider;
let jim: UserRow;
let ana: UserRow;
let boss: UserRow;

function app() {
  const users = new Map([jim, ana, boss].map((u) => [u.id, u]));
  const hono = new Hono<AppEnv>();
  hono.use('*', async (c, next) => {
    const user = users.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  hono.route('/api/chat-files', chatFiles);
  return hono;
}

beforeEach(async () => {
  _resetProvider();
  objects.clear();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const stamp = `${Date.now()}-${Math.random()}`;
  jim = await createInternalTestUser(db, { email: `jim-${stamp}@test.local`, nickname: 'Jim', role: 'team' });
  ana = await createInternalTestUser(db, { email: `ana-${stamp}@test.local`, nickname: 'Ana', role: 'team' });
  boss = await createInternalTestUser(db, { email: `boss-${stamp}@test.local`, nickname: 'Boss', role: 'super' });
});

describe('Bot screenshots', () => {
  it("open only for the conversation's owner", async () => {
    const conversation = await db.sessions.create('Sage', 'sprouty', jim.id, undefined, 'bots');
    const stored = await storeScreenshotAsChatFile(PNG, { db, userId: jim.id, sessionId: conversation.id });

    expect(stored.download_url).toBe(`/api/chat-files/${stored.file_id}/content`);
    const row = await db.chatFiles.getById(stored.file_id);
    expect(row).toMatchObject({
      session_id: conversation.id,
      content_type: 'image/png',
      source: 'agent',
      created_by: jim.id,
      size: PNG.length,
    });

    const get = (as: UserRow) => app().request(stored.download_url, { headers: { 'x-test-user': as.id } });
    const owner = await get(jim);
    expect(owner.status).toBe(200);
    expect(owner.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await owner.arrayBuffer())).toEqual(PNG);
    // Bots conversations are owner-only, super included.
    expect((await get(ana)).status).toBe(404);
    expect((await get(boss)).status).toBe(404);
  });

  it('goes with the conversation when the screenshot row cannot be written', async () => {
    await expect(
      storeScreenshotAsChatFile(PNG, { db, userId: jim.id, sessionId: 'no-such-conversation' }),
    ).rejects.toThrow();
    expect(objects.size).toBe(0);
  });
});
