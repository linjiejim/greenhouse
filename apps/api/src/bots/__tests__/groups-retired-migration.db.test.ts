/**
 * Migration 0015_bots_groups_retired, replayed against fixtures inside the test
 * transaction (the test database is already migrated; the statements are
 * idempotent data updates). Group chats are retired: every still-pending card of
 * a group is withdrawn as `canceled`, every conversation's deprecated
 * `allow_bot_chat` reads true — and nothing is deleted.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

import { insertLegacyGroup } from './helpers/legacy-group.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

const MIGRATION = resolve(import.meta.dirname, '../../../../../drizzle/0015_bots_groups_retired.sql');

let db: DatabaseProvider;
let user: UserRow;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  user = await createInternalTestUser(db, { email: `bots-0015-${Date.now()}-${Math.random()}@test.local` });
});

async function migrate(): Promise<void> {
  const statements = readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await db.executeRaw(sql.raw(statement));
}

async function counts(): Promise<Record<string, number>> {
  const [row] = (await db.executeRaw(sql`
    SELECT
      (SELECT count(*) FROM bot_conversations WHERE user_id = ${user.id}) AS conversations,
      (SELECT count(*) FROM bot_conversation_members WHERE user_id = ${user.id}) AS members,
      (SELECT count(*) FROM bot_requests WHERE user_id = ${user.id}) AS requests,
      (SELECT count(*) FROM messages m JOIN bot_conversations c ON c.session_id = m.session_id
        WHERE c.user_id = ${user.id}) AS messages
  `)) as Array<Record<string, string>>;
  return Object.fromEntries(Object.entries(row!).map(([key, value]) => [key, Number(value)]));
}

describe('migration 0015 — Bots group chats retired', () => {
  it('cancels pending group cards only, turns every switch on, deletes nothing', async () => {
    const ivy = await db.bots.createBot({ user_id: user.id, name: 'Ivy' });
    const fern = await db.bots.createBot({ user_id: user.id, name: 'Fern' });
    const dm = await db.bots.ensureDirectConversation(user.id, ivy.id);
    const groupId = await insertLegacyGroup(db, {
      userId: user.id,
      botIds: [ivy.id, fern.id],
      title: 'Launch',
      allowBotChat: false,
    });
    await db.executeRaw(sql`UPDATE bot_conversations SET allow_bot_chat = false WHERE session_id = ${dm.session_id}`);
    await db.sessions.addMessage({ session_id: groupId, role: 'user', content: 'old history' });

    const card = (sessionId: string, kind: 'approval' | 'task_start') =>
      db.bots.createRequest({
        user_id: user.id,
        session_id: sessionId,
        bot_id: ivy.id,
        kind,
        payload: kind === 'approval' ? { action: 'tool_call', title: 'x', details: [], allow_always: false } : {},
      });
    const groupPending = await card(groupId, 'task_start');
    const groupDecided = await card(groupId, 'approval');
    await db.bots.settleRequest(user.id, groupDecided.id, 'resolved', { decision: 'approve' });
    const dmPending = await card(dm.session_id, 'approval');
    // Stamp the old cards in the past so the migration's own timestamp is visible.
    await db.executeRaw(sql`UPDATE bot_requests SET updated_at = '2026-10-01T00:00:00Z' WHERE user_id = ${user.id}`);
    const before = await counts();

    await migrate();

    const withdrawn = await db.bots.getRequest(user.id, groupPending.id);
    expect(withdrawn).toMatchObject({ status: 'canceled', result: '{"decision":"group_closed"}' });
    const [stamp] = (await db.executeRaw(
      sql`SELECT updated_at > '2026-10-01T00:00:00Z' AS touched FROM bot_requests WHERE id = ${groupPending.id}`,
    )) as Array<{ touched: boolean }>;
    expect(stamp?.touched).toBe(true);
    expect(await db.bots.getRequest(user.id, groupDecided.id)).toMatchObject({
      status: 'resolved',
      result: JSON.stringify({ decision: 'approve' }),
    });
    expect(await db.bots.getRequest(user.id, dmPending.id)).toMatchObject({ status: 'pending', result: null });

    for (const sessionId of [dm.session_id, groupId]) {
      expect((await db.bots.getConversation(user.id, sessionId))?.allow_bot_chat).toBe(true);
    }
    const group = await db.bots.getConversation(user.id, groupId);
    expect(group).toMatchObject({ kind: 'group', title: 'Launch', lead_bot_id: ivy.id });
    expect(await counts()).toEqual(before);

    // Re-running it changes nothing (a replayed or adopted chain is harmless).
    await migrate();
    expect(await db.bots.getRequest(user.id, dmPending.id)).toMatchObject({ status: 'pending' });
    expect(await counts()).toEqual(before);
  });
});
