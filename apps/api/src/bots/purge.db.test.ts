/**
 * Bots transcripts leave with their member (real PostgreSQL).
 *
 * Deleting a member used to leave their `channel='bots'` sessions behind —
 * private page text and shell output nobody could delete any more, because
 * Bots conversations are owner-only. The member's other sessions must still
 * outlive them (the general history-preserving rule).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../tests/helpers/internal-user.js';
import { purgeBotsConversations } from './purge.js';

let db: DatabaseProvider;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
});

async function seedMember(tag: string) {
  const user = await createInternalTestUser(db, { email: `bots-purge-${tag}-${Date.now()}@test.local` });
  const bots = await db.sessions.create('Bots DM', 'sprouty', user.id, undefined, 'bots');
  await db.sessions.addMessage({ session_id: bots.id, role: 'user', content: 'Book the flight' });
  const task = await db.sessions.create('Research', 'sprouty', user.id, undefined, 'subagent', bots.id, {
    id: `bottask-${bots.id.slice(0, 8)}-${tag}`,
  });
  const web = await db.sessions.create('Chat', 'sprouty', user.id, undefined, 'web');
  return { user, bots, task, web };
}

describe('purgeBotsConversations', () => {
  it("selects only a member's Bots conversations and their background-task children", async () => {
    const { user, bots, task, web } = await seedMember('select');
    const ids = await db.sessions.listIdsLeavingWithOwner(user.id, { channels: ['bots'], idPrefixes: ['bottask-'] });
    expect(ids.sort()).toEqual([bots.id, task.id].sort());
    expect(ids).not.toContain(web.id);
  });

  it('deletes them with their messages and keeps the rest of the history', async () => {
    const { user, bots, task, web } = await seedMember('delete');
    const other = await seedMember('other');

    const result = await purgeBotsConversations(user.id);

    expect(result).toEqual({ deleted: 2, deferred: 0 });
    expect(await db.sessions.getById(bots.id)).toBeUndefined();
    expect(await db.sessions.getById(task.id)).toBeUndefined();
    expect(await db.sessions.getMessages(bots.id)).toEqual([]);
    expect(await db.sessions.getById(web.id)).toBeDefined();
    // Another member's Bots conversations are untouched.
    expect(await db.sessions.getById(other.bots.id)).toBeDefined();
  });

  it('sweeps the Bots conversations of members that no longer exist', async () => {
    const { user, bots, task, web } = await seedMember('orphan');
    const alive = await seedMember('alive');
    await db.users.delete(user.id);

    const orphans = await db.sessions.listIdsLeavingWithOwner(null, { channels: ['bots'], idPrefixes: ['bottask-'] });
    expect(orphans).toEqual(expect.arrayContaining([bots.id, task.id]));
    expect(orphans).not.toContain(alive.bots.id);
    expect(orphans).not.toContain(web.id);

    await purgeBotsConversations(null);
    expect(await db.sessions.getById(bots.id)).toBeUndefined();
    expect(await db.sessions.getById(web.id)).toBeDefined();
    expect(await db.sessions.getById(alive.bots.id)).toBeDefined();
  });
});
