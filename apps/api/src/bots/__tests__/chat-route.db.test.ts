/**
 * POST /api/chat on a Bots conversation, end to end through the real route:
 * the member message is persisted, the Bots engine streams per-Bot segments
 * into the NDJSON response with exactly one `finish`, a second POST while the
 * conversation is busy is queued (202) and answered in the same run. Only the
 * owner drives their Bots — a super included (spec §10); a conversation
 * nobody can answer is refused (409); a message never jumps an older queued one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { chatRunRegistry } from '../../chat/runs.js';
import { createChatRoute } from '../../routes/chat.js';
import { canWriteSession } from '../../sessions/access.js';
import { setBotsEngineDepsForTest } from '../engine/deps.js';
import { scriptedDeps } from '../engine/__tests__/scripted-model.js';

vi.mock('../../ws/connection-manager.js', () => ({ connectionManager: { sendToUser: vi.fn() } }));

let db: DatabaseProvider;
let jim: UserRow;
let ana: UserRow;
let boss: UserRow;
let restore: (() => void) | null = null;

function app() {
  const users = new Map([jim, ana, boss].map((u) => [u.id, u]));
  const hono = new Hono<AppEnv>();
  hono.use('*', async (c, next) => {
    const user = users.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  hono.route('/api/chat', createChatRoute({}));
  return hono;
}

function post(as: UserRow, body: unknown) {
  return app().request('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': as.id },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  jim = await createInternalTestUser(db, {
    email: `bots-route-${Date.now()}-${Math.random()}@test.local`,
    nickname: 'Jim',
  });
  ana = await createInternalTestUser(db, {
    email: `bots-route-ana-${Date.now()}-${Math.random()}@test.local`,
    nickname: 'Ana',
  });
  boss = await createInternalTestUser(db, {
    email: `bots-route-boss-${Date.now()}-${Math.random()}@test.local`,
    nickname: 'Boss',
    role: 'super',
  });
});

function ndjson(text: string) {
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; bot_id?: string; reason?: string; status?: string });
}

afterEach(() => {
  restore?.();
  restore = null;
});

describe('POST /api/chat on a Bots conversation', () => {
  it('streams the Bot’s segment and one finish, and persists both rows', async () => {
    const ivy = await db.bots.createBot({ user_id: jim.id, name: 'Ivy' });
    const dm = await db.bots.ensureDirectConversation(jim.id, ivy.id);
    restore = setBotsEngineDepsForTest(scriptedDeps({ Ivy: [[{ text: 'On it.' }]] }));

    const res = await post(jim, { session_id: dm.session_id, messages: [{ role: 'user', content: 'Plan my day' }] });
    expect(res.status).toBe(200);
    const lines = (await res.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; bot_id?: string; status?: string; text?: string });
    const types = lines.map((line) => line.type).filter((type) => type !== 'ping');
    expect(types[0]).toBe('bot-turn-start');
    expect(types.at(-1)).toBe('finish');
    expect(types.filter((type) => type === 'finish')).toHaveLength(1);
    expect(lines.find((line) => line.type === 'bot-turn-end')).toMatchObject({ bot_id: ivy.id, status: 'completed' });
    const rows = await db.sessions.getMessages(dm.session_id);
    expect(rows.map((r) => [r.role, r.bot_id ?? null, r.content])).toEqual([
      ['user', null, 'Plan my day'],
      ['assistant', ivy.id, 'On it.'],
    ]);
  });

  it('queues a message sent while the conversation is busy (202) and never lets another member in', async () => {
    const ivy = await db.bots.createBot({ user_id: jim.id, name: 'Ivy' });
    const dm = await db.bots.ensureDirectConversation(jim.id, ivy.id);
    const busy = chatRunRegistry.claim(dm.session_id, jim.id)!;
    try {
      const queued = await post(jim, { session_id: dm.session_id, messages: [{ role: 'user', content: 'also this' }] });
      expect(queued.status).toBe(202);
      expect(await queued.json()).toEqual({ queued: true });
      expect(await db.bots.listPendingInbox(dm.session_id)).toHaveLength(1);
      expect(await db.sessions.getMessageCount(dm.session_id)).toBe(0);
    } finally {
      chatRunRegistry.release(busy);
    }
    const intruder = await post(ana, { session_id: dm.session_id, messages: [{ role: 'user', content: 'hi' }] });
    expect(intruder.status).toBe(404);
    const regenerate = await post(jim, { session_id: dm.session_id, regenerate_assistant_message_id: 'x' });
    expect(regenerate.status).toBe(409);
  });

  it('never lets a super drive (or stop) a member’s Bots', async () => {
    const ivy = await db.bots.createBot({ user_id: jim.id, name: 'Ivy' });
    const dm = await db.bots.ensureDirectConversation(jim.id, ivy.id);
    const session = (await db.sessions.getById(dm.session_id))!;
    // The rule itself: owner-only for the Bots channel, unlike ordinary chat.
    expect(canWriteSession({ id: boss.id, role: 'super' }, session)).toBe(false);
    expect(canWriteSession({ id: jim.id, role: 'team' }, session)).toBe(true);
    expect(canWriteSession({ id: ana.id, role: 'team' }, session)).toBe(false);
    expect(canWriteSession({ id: boss.id, role: 'super' }, { ...session, channel: 'web' })).toBe(true);

    // Idle: nothing persisted.
    const idle = await post(boss, { session_id: dm.session_id, messages: [{ role: 'user', content: 'do it' }] });
    expect(idle.status).toBe(404);
    expect(await db.sessions.getMessageCount(dm.session_id)).toBe(0);

    // Busy (the path that would queue into the owner's running Bots): nothing queued,
    // and the owner's run can be neither stopped nor watched.
    const busy = chatRunRegistry.claim(dm.session_id, jim.id)!;
    try {
      const queued = await post(boss, { session_id: dm.session_id, messages: [{ role: 'user', content: 'do it' }] });
      expect(queued.status).toBe(404);
      expect(await db.bots.listPendingInbox(dm.session_id)).toHaveLength(0);
      const stop = await app().request(`/api/chat/runs/${dm.session_id}/stop`, {
        method: 'POST',
        headers: { 'x-test-user': boss.id },
      });
      expect(stop.status).toBe(404);
      expect(busy.signal.aborted).toBe(false);
      const stream = await app().request(`/api/chat/runs/${dm.session_id}/stream`, {
        headers: { 'x-test-user': boss.id },
      });
      expect(stream.status).toBe(404);
    } finally {
      chatRunRegistry.release(busy);
    }
  });

  it('refuses a message nobody can answer: an archived DM owner, a group without active Bots', async () => {
    const ivy = await db.bots.createBot({ user_id: jim.id, name: 'Ivy' });
    const fern = await db.bots.createBot({ user_id: jim.id, name: 'Fern' });
    const sage = await db.bots.createBot({ user_id: jim.id, name: 'Sage' });
    const dm = await db.bots.ensureDirectConversation(jim.id, ivy.id);
    const group = await db.bots.createGroupConversation({ user_id: jim.id, bot_ids: [fern.id, sage.id] });
    await db.bots.archiveBot(jim.id, ivy.id);
    await db.bots.archiveBot(jim.id, fern.id);
    await db.bots.archiveBot(jim.id, sage.id);

    const toDm = await post(jim, { session_id: dm.session_id, messages: [{ role: 'user', content: 'hello?' }] });
    expect(toDm.status).toBe(409);
    expect(await toDm.json()).toMatchObject({ code: 'bot_archived' });
    const toGroup = await post(jim, { session_id: group.session_id, messages: [{ role: 'user', content: 'anyone?' }] });
    expect(toGroup.status).toBe(409);
    expect(await toGroup.json()).toMatchObject({ code: 'no_active_members' });
    expect(await db.sessions.getMessageCount(dm.session_id)).toBe(0);
    expect(await db.sessions.getMessageCount(group.session_id)).toBe(0);
  });

  it('accepts an image-only message', async () => {
    const ivy = await db.bots.createBot({ user_id: jim.id, name: 'Ivy' });
    const dm = await db.bots.ensureDirectConversation(jim.id, ivy.id);
    restore = setBotsEngineDepsForTest(scriptedDeps({ Ivy: [[{ text: 'Nice screenshot.' }]] }));
    const images = [{ id: 'img_1', url: '/api/upload/img_1' }];

    const res = await post(jim, { session_id: dm.session_id, messages: [{ role: 'user', content: '', images }] });
    expect(res.status).toBe(200);
    await res.text();
    const rows = await db.sessions.getMessages(dm.session_id);
    expect(rows[0]).toMatchObject({ role: 'user', content: '' });
    expect(JSON.parse(rows[0]!.images)).toEqual(images);
    expect(rows[1]).toMatchObject({ role: 'assistant', content: 'Nice screenshot.' });

    const empty = await post(jim, { session_id: dm.session_id, messages: [{ role: 'user', content: '  ' }] });
    expect(empty.status).toBe(400);
  });

  it('a new message never jumps an older queued one: both are written in order and the newer one leads', async () => {
    const ivy = await db.bots.createBot({ user_id: jim.id, name: 'Ivy' });
    const fern = await db.bots.createBot({ user_id: jim.id, name: 'Fern' });
    const group = await db.bots.createGroupConversation({ user_id: jim.id, bot_ids: [ivy.id, fern.id] });
    // Left behind by a stopped run: "also check X" (no mention).
    await db.bots.enqueueInbox(group.session_id, 'user_message', {
      kind: 'user_message',
      content: 'also check X',
      mentions: [],
    });
    restore = setBotsEngineDepsForTest(scriptedDeps({ Fern: [[{ text: 'Drafting now.' }]] }));

    const res = await post(jim, {
      session_id: group.session_id,
      messages: [{ role: 'user', content: '@Fern draft it now' }],
      mentions: [fern.id],
    });
    expect(res.status).toBe(200);
    const lines = ndjson(await res.text());
    expect(lines.find((line) => line.type === 'bot-turn-start')).toMatchObject({ bot_id: fern.id, reason: 'mention' });
    expect(lines.filter((line) => line.type === 'finish')).toHaveLength(1);
    const rows = await db.sessions.getMessages(group.session_id);
    expect(rows.map((r) => [r.role, r.content])).toEqual([
      ['user', 'also check X'],
      ['user', '@Fern draft it now'],
      ['assistant', 'Drafting now.'],
    ]);
    expect(await db.bots.listPendingInbox(group.session_id)).toHaveLength(0);
  });
});
