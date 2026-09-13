/**
 * Chat attachment upload — ownership and quota, against a real database.
 *
 * Reading a chat file follows the session's read policy (a shared conversation
 * stays readable by its recipients), but WRITING is owner-only: being able to
 * see a conversation must not let you plant files in it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

process.env.TOKEN_SIGNING_KEY = process.env.TOKEN_SIGNING_KEY ?? '11'.repeat(32);

import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;

const unique = () => `${Date.now()}-${Math.random()}`;

describe('chat file attachments', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    owner = await createInternalTestUser(db, { email: `cf-${unique()}@test.local` });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('scopes id resolution to one session — a copied id from elsewhere resolves to nothing', async () => {
    const mine = await db.sessions.create('Mine', 'sprouty-quick', owner.id);
    const other = await db.sessions.create('Other', 'sprouty-quick', owner.id);
    const file = await db.chatFiles.create({
      session_id: other.id,
      name: 'secret.csv',
      content_type: 'text/csv',
      size: 10,
      storage_key: `chat-files/${owner.id}/${unique()}/secret.csv`,
      source: 'user',
      created_by: owner.id,
    });

    expect(await db.chatFiles.listBySessionAndIds(other.id, [file.id])).toHaveLength(1);
    // Same id, wrong conversation — this is the lookup read_attachment performs.
    expect(await db.chatFiles.listBySessionAndIds(mine.id, [file.id])).toHaveLength(0);
  });

  it('counts only user uploads toward the quota, not tool output', async () => {
    const session = await db.sessions.create('S', 'sprouty-quick', owner.id);
    await db.chatFiles.create({
      session_id: session.id,
      name: 'export.xlsx',
      content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 1000,
      storage_key: `chat-files/${owner.id}/${unique()}/export.xlsx`,
      // no `source` → defaults to 'agent', matching every pre-existing row
      created_by: owner.id,
    });
    expect(await db.chatFiles.totalUploadedBytes(owner.id)).toBe(0);

    await db.chatFiles.create({
      session_id: session.id,
      name: 'input.csv',
      content_type: 'text/csv',
      size: 250,
      storage_key: `chat-files/${owner.id}/${unique()}/input.csv`,
      source: 'user',
      created_by: owner.id,
    });
    expect(await db.chatFiles.totalUploadedBytes(owner.id)).toBe(250);
  });

  it('keeps quotas per user', async () => {
    const stranger = await createInternalTestUser(db, { email: `cf-other-${unique()}@test.local` });
    const session = await db.sessions.create('S', 'sprouty-quick', owner.id);
    await db.chatFiles.create({
      session_id: session.id,
      name: 'a.csv',
      content_type: 'text/csv',
      size: 999,
      storage_key: `chat-files/${owner.id}/${unique()}/a.csv`,
      source: 'user',
      created_by: owner.id,
    });
    expect(await db.chatFiles.totalUploadedBytes(stranger.id)).toBe(0);
  });

  it('drops a session’s files with the session', async () => {
    const session = await db.sessions.create('S', 'sprouty-quick', owner.id);
    const file = await db.chatFiles.create({
      session_id: session.id,
      name: 'gone.csv',
      content_type: 'text/csv',
      size: 5,
      storage_key: `chat-files/${owner.id}/${unique()}/gone.csv`,
      source: 'user',
      created_by: owner.id,
    });
    await db.sessions.delete(session.id);
    expect(await db.chatFiles.getById(file.id)).toBeUndefined();
  });
});
