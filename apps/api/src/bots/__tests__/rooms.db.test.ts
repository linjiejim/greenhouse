/**
 * Rooms — several people and the Agents they bring (spec 20261011-agent-first-class P5, D42–D46)
 * against real PostgreSQL with a scripted model: a room or the pair's one private chat, readable
 * and writable by its people only (super included), messages with their author, an Agent that
 * answers only an allowed @-mention in a run of the person who asked, someone else's mention
 * waiting for their own run, per-person unread markers, public Agents only while everyone is in
 * the audience, leaving (with your Agents; ownership passes on; the last one out deletes it), and
 * an account purge that keeps everyone else's room.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type BotRow, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { chatRunRegistry } from '../../chat/runs.js';
import { canAccessSession, canPostToSession, canWriteSession, superSeesAllChats } from '../../sessions/access.js';
import { setBotsEngineDepsForTest } from '../engine/deps.js';
import { forgetConversationAudience } from '../engine/fanout.js';
import { deliverToConversation } from '../engine/index.js';
import { _resetInboxStateForTest, setInboxToolRegistry } from '../engine/inbox.js';
import { claimBotsRun, releaseBotsRun } from '../engine/run-slot.js';
import { runBotsRun } from '../engine/chain.js';
import { scriptedDeps, type BotScript, type CapturedTurn } from '../engine/__tests__/scripted-model.js';
import { purgeBotsConversations } from '../purge.js';
import { addressableMentions } from '../room-access.js';
import { createRoomsRoutes } from '../rooms.js';
import { createBotsRoutes } from '../routes.js';

vi.mock('../../ws/connection-manager.js', () => ({ connectionManager: { sendToUser: vi.fn() } }));

let db: DatabaseProvider;
let jim: UserRow;
let ana: UserRow;
let ben: UserRow;
let boss: UserRow;
let ivy: BotRow; // Jim's
let sage: BotRow; // Ana's
let restoreDeps: (() => void) | null = null;

function app() {
  const users = new Map([jim, ana, ben, boss].map((u) => [u.id, u]));
  const hono = new Hono<AppEnv>();
  hono.use('*', async (c, next) => {
    const user = users.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  hono.route('/api/bots', createBotsRoutes());
  hono.route('/api/rooms', createRoomsRoutes());
  return hono;
}

async function call(as: UserRow, method: string, path: string, body?: unknown) {
  const res = await app().request(path, {
    method,
    headers: { 'x-test-user': as.id, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const stamp = `${Date.now()}-${Math.random()}`;
  jim = await createInternalTestUser(db, { email: `room-jim-${stamp}@test.local`, nickname: 'Jim', role: 'team' });
  ana = await createInternalTestUser(db, { email: `room-ana-${stamp}@test.local`, nickname: 'Ana', role: 'team' });
  ben = await createInternalTestUser(db, { email: `room-ben-${stamp}@test.local`, nickname: 'Ben', role: 'team' });
  boss = await createInternalTestUser(db, { email: `room-boss-${stamp}@test.local`, nickname: 'Boss', role: 'super' });
  ivy = await db.bots.createBot({ user_id: jim.id, name: 'Ivy', role: 'Researcher' });
  sage = await db.bots.createBot({ user_id: ana.id, name: 'Sage', role: 'Analyst' });
  setInboxToolRegistry({});
});

afterEach(() => {
  restoreDeps?.();
  restoreDeps = null;
  setInboxToolRegistry(null);
  _resetInboxStateForTest();
  delete process.env.SUPER_READS_CHATS;
});

function useScript(script: BotScript, captured: CapturedTurn[] = []) {
  restoreDeps = setBotsEngineDepsForTest(scriptedDeps(script, captured));
}

/** Wait for the room's queue and runs to settle (deliveries start runs in the background). */
async function settled(sessionId: string) {
  for (let i = 0; i < 200; i += 1) {
    const busy = chatRunRegistry.getActive(sessionId) || (await db.bots.listPendingInbox(sessionId)).length > 0;
    if (!busy) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the room never settled');
}

async function transcript(sessionId: string) {
  const page = await db.sessions.getMessagePage(sessionId, { limit: 50 });
  return page.messages.map((m) => [m.role, m.author_user_id ?? m.bot_id ?? null, m.content]);
}

/** A room of Jim and Ana with Ivy (Jim's) and Sage (Ana's). */
async function roomWithAgents() {
  const created = await call(jim, 'POST', '/api/rooms', { user_ids: [ana.id], title: 'Launch', bot_ids: [ivy.id] });
  expect(created.status).toBe(201);
  const id = created.json.conversation.session_id as string;
  expect((await call(ana, 'POST', `/api/rooms/${id}/agents`, { bot_id: sage.id })).status).toBe(200);
  await settled(id);
  return id;
}

describe('rooms: who is in, who can read', () => {
  it('creates a room, or reuses the pair’s one private chat', async () => {
    const first = await call(jim, 'POST', '/api/rooms', { user_ids: [ana.id] });
    expect(first.status).toBe(201);
    expect(first.json.conversation).toMatchObject({
      kind: 'room',
      title: null,
      owner_bot_id: null,
      participants: [
        expect.objectContaining({ user_id: jim.id, nickname: 'Jim', role: 'owner' }),
        expect.objectContaining({ user_id: ana.id, nickname: 'Ana', role: 'member' }),
      ],
    });
    // The same two people, no title, no Agents: the same private chat, from either side.
    const again = await call(ana, 'POST', '/api/rooms', { user_ids: [jim.id] });
    expect(again.status).toBe(200);
    expect(again.json.conversation.session_id).toBe(first.json.conversation.session_id);
    // A title makes it a room of its own.
    const titled = await call(jim, 'POST', '/api/rooms', { user_ids: [ana.id], title: 'Q4' });
    expect(titled.json.conversation.session_id).not.toBe(first.json.conversation.session_id);

    // Whom Jim can pick: active members with Agents, never himself.
    const people = (await call(jim, 'GET', '/api/rooms/people')).json.people.map((p: any) => p.id);
    expect(people).toEqual(expect.arrayContaining([ana.id, ben.id, boss.id]));
    expect(people).not.toContain(jim.id);

    expect((await call(jim, 'POST', '/api/rooms', { user_ids: [] })).status).toBe(400);
    expect((await call(jim, 'POST', '/api/rooms', { user_ids: ['nobody'] })).status).toBe(400);
  });

  it('is read and written by its people only — super included — and listed for each of them', async () => {
    const id = (await call(jim, 'POST', '/api/rooms', { user_ids: [ana.id] })).json.conversation.session_id;
    expect((await call(ana, 'GET', `/api/bots/conversations/${id}`)).status).toBe(200);
    expect((await call(ben, 'GET', `/api/bots/conversations/${id}`)).status).toBe(404);
    expect((await call(boss, 'GET', `/api/bots/conversations/${id}`)).status).toBe(404);
    expect(
      (await call(ana, 'GET', '/api/bots/conversations')).json.conversations.map((c: any) => c.session_id),
    ).toContain(id);
    expect((await call(ana, 'GET', '/api/rooms')).json.rooms.map((r: any) => r.session_id)).toEqual([id]);
    expect((await call(ben, 'GET', '/api/rooms')).json.rooms).toEqual([]);

    const session = (await db.sessions.getById(id))!;
    const as = (u: UserRow) => ({ id: u.id, role: u.role });
    expect(await canAccessSession(as(ana), session)).toBe(true);
    expect(await canPostToSession(as(ana), session)).toBe(true);
    // Administering the session stays its owner's; super never reads a room.
    expect(canWriteSession(as(ana), session)).toBe(false);
    expect(await canAccessSession(as(boss), session)).toBe(false);
    expect(await canPostToSession(as(ben), session)).toBe(false);
  });

  it('keeps super out of other members’ ordinary chats unless the deployment says otherwise', async () => {
    const chat = await db.sessions.create('Plans', undefined, jim.id, undefined, 'web');
    const asBoss = { id: boss.id, role: boss.role };
    expect(superSeesAllChats(asBoss)).toBe(false);
    expect(await canAccessSession(asBoss, chat)).toBe(false);
    expect(canWriteSession(asBoss, chat)).toBe(false);
    process.env.SUPER_READS_CHATS = 'true';
    expect(await canAccessSession(asBoss, chat)).toBe(true);
    expect(canWriteSession(asBoss, chat)).toBe(true);
  });
});

describe('rooms: who answers', () => {
  it('an Agent answers only its allowed asker, in a run that is theirs; others’ lines are information', async () => {
    const captured: CapturedTurn[] = [];
    useScript({ Ivy: [[{ text: 'Here is the summary.' }]], Sage: [[{ text: 'Numbers look fine.' }]] }, captured);
    const id = await roomWithAgents();
    const room = (await db.bots.getConversation(ana.id, id))!;
    // Ana may @ her Sage, never Jim's private Ivy.
    expect(await addressableMentions(db, ana.id, room, [ivy.id, sage.id, 'nope'])).toEqual([sage.id]);
    expect(await addressableMentions(db, jim.id, room, [ivy.id, sage.id])).toEqual([ivy.id]);

    // Ana talks (no allowed mention): nobody answers, and no "unavailable" line either.
    await deliverToConversation(id, {
      kind: 'user_message',
      content: 'I think we ship Monday',
      mentions: [],
      author_user_id: ana.id,
    });
    await settled(id);
    // Jim asks Ivy.
    await deliverToConversation(id, {
      kind: 'user_message',
      content: '@Ivy summarize the plan',
      mentions: [ivy.id],
      author_user_id: jim.id,
    });
    await settled(id);

    const rows = await transcript(id);
    expect(rows.filter((r) => r[0] !== 'system')).toEqual([
      ['user', ana.id, 'I think we ship Monday'],
      ['user', jim.id, '@Ivy summarize the plan'],
      ['assistant', ivy.id, 'Here is the summary.'],
    ]);
    expect(captured.map((t) => t.bot)).toEqual(['Ivy']);
    const ivyTurn = captured[0]!.input;
    // Jim is the member; Ana's line is a participant's, and the room rules are in.
    const history = JSON.stringify(ivyTurn.messages);
    expect(history).toContain('[Ana (participant)]:');
    expect(history).toContain('[Jim (user)]:');
    expect(ivyTurn.systemPrompt).toContain('conversation between several people');
    // No hand-offs or background tasks in a room.
    expect(Object.keys(ivyTurn.tools ?? {})).not.toContain('team');
    expect(Object.keys(ivyTurn.tools ?? {})).not.toContain('bot_tasks');
  });

  it('someone else’s mention during a run is written at once and answered in a run of theirs afterwards', async () => {
    const captured: CapturedTurn[] = [];
    useScript({ Ivy: [[{ text: 'Ivy here.' }]], Sage: [[{ text: 'Sage here.' }]] }, captured);
    const id = await roomWithAgents();
    // Jim's run holds the room while both messages arrive.
    const run = (await claimBotsRun(db, id, jim.id))!;
    await deliverToConversation(id, {
      kind: 'user_message',
      content: '@Sage check numbers',
      mentions: [sage.id],
      author_user_id: ana.id,
    });
    await deliverToConversation(id, {
      kind: 'user_message',
      content: '@Ivy draft it',
      mentions: [ivy.id],
      author_user_id: jim.id,
    });
    const latest = await db.sessions.getLatestMessage(id);
    await runBotsRun({
      run,
      userId: jim.id,
      sessionId: id,
      toolRegistry: {},
      trigger: { kind: 'continue', items: [] },
      triggerKey: latest!.id,
      db,
    });
    await settled(id);

    const rows = (await transcript(id)).filter((r) => r[0] !== 'system');
    expect(rows).toEqual([
      ['user', ana.id, '@Sage check numbers'],
      ['user', jim.id, '@Ivy draft it'],
      ['assistant', ivy.id, 'Ivy here.'],
      ['assistant', sage.id, 'Sage here.'],
    ]);
    // Sage answered in Ana's run: Ana is its member there.
    const sageTurn = captured.find((t) => t.bot === 'Sage')!.input;
    expect(JSON.stringify(sageTurn.messages)).toContain('[Ana (user)]:');
    expect(JSON.stringify(sageTurn.messages)).toContain('[Jim (participant)]:');
    await releaseBotsRun(db, run).catch(() => undefined);
  });

  it('keeps an unread count and a read marker per person', async () => {
    const id = (await call(jim, 'POST', '/api/rooms', { user_ids: [ana.id] })).json.conversation.session_id;
    await deliverToConversation(id, {
      kind: 'user_message',
      content: 'hello Ana',
      mentions: [],
      author_user_id: jim.id,
    });
    await settled(id);
    const unreadFor = async (u: UserRow) =>
      (await call(u, 'GET', '/api/bots/conversations')).json.conversations.find((c: any) => c.session_id === id);
    expect(await unreadFor(ana)).toMatchObject({ unread_count: 1, attention: 'unread' });
    expect(await unreadFor(jim)).toMatchObject({ unread_count: 0 });
    await call(ana, 'POST', `/api/bots/conversations/${id}/read`);
    expect(await unreadFor(ana)).toMatchObject({ unread_count: 0 });
  });
});

describe('rooms: Agents and people coming and going', () => {
  it('a public Agent stays only while everyone here is in its audience', async () => {
    const helpdesk = await db.bots.createBot({ user_id: jim.id, name: 'Helpdesk', role: 'IT' });
    await db.bots.setPublication(jim.id, helpdesk.id, {
      visibility: 'public',
      published_version: 1,
      publication: JSON.stringify({ audience: { everyone: false, user_ids: [ana.id], group_ids: [] } }),
    });
    const id = (await call(ana, 'POST', '/api/rooms', { user_ids: [jim.id], title: 'IT' })).json.conversation
      .session_id as string;
    // Ana brings Jim's public Helpdesk: everyone here (Jim owns it, Ana is in its audience) may use it.
    expect((await call(ana, 'POST', `/api/rooms/${id}/agents`, { bot_id: helpdesk.id })).status).toBe(200);
    // Ben joins — he is not in its audience: it leaves, with a line saying why.
    expect((await call(ana, 'POST', `/api/rooms/${id}/participants`, { user_id: ben.id })).status).toBe(200);
    await settled(id);
    const detail = (await call(ben, 'GET', `/api/bots/conversations/${id}`)).json;
    expect(detail.conversation.members).toEqual([]);
    expect(detail.messages.map((m: any) => m.content)).toEqual(
      expect.arrayContaining([expect.stringContaining('shared with everyone here')]),
    );
    // And it cannot come back while Ben is here.
    expect(await call(ana, 'POST', `/api/rooms/${id}/agents`, { bot_id: helpdesk.id })).toMatchObject({
      status: 409,
      json: { code: 'agent_not_shared' },
    });
    // Someone else's private Agent can never be brought in.
    expect(await call(ana, 'POST', `/api/rooms/${id}/agents`, { bot_id: ivy.id })).toMatchObject({
      status: 404,
      json: { code: 'agent_not_found' },
    });
  });

  it('leaving takes your Agents along; ownership passes on; the last one out deletes it', async () => {
    const id = await roomWithAgents();
    // Only the owner removes someone else.
    expect((await call(ana, 'DELETE', `/api/rooms/${id}/participants/${jim.id}`)).status).toBe(403);
    expect((await call(ana, 'DELETE', `/api/rooms/${id}/participants/${ana.id}`)).json).toMatchObject({
      ok: true,
      deleted: false,
    });
    await settled(id);
    forgetConversationAudience(id);
    const after = (await call(jim, 'GET', `/api/bots/conversations/${id}`)).json.conversation;
    expect(after.members.map((m: any) => m.bot_id)).toEqual([ivy.id]);
    expect(after.participants.map((p: any) => p.user_id)).toEqual([jim.id]);
    expect((await call(ana, 'GET', `/api/bots/conversations/${id}`)).status).toBe(404);

    // Ben joins, Jim (the owner) leaves: Ben owns it now, Ivy left with Jim.
    await call(jim, 'POST', `/api/rooms/${id}/participants`, { user_id: ben.id });
    await call(jim, 'DELETE', `/api/rooms/${id}/participants/${jim.id}`);
    await settled(id);
    const benView = (await call(ben, 'GET', `/api/bots/conversations/${id}`)).json.conversation;
    expect(benView.participants).toEqual([expect.objectContaining({ user_id: ben.id, role: 'owner' })]);
    expect(benView.members).toEqual([]);
    expect((await db.sessions.getById(id))?.user_id).toBe(ben.id);

    expect((await call(ben, 'DELETE', `/api/rooms/${id}/participants/${ben.id}`)).json).toMatchObject({
      deleted: true,
    });
    expect(await db.sessions.getById(id)).toBeUndefined();
  });

  it('a purged account leaves its rooms instead of deleting them under everyone', async () => {
    const id = (await call(jim, 'POST', '/api/rooms', { user_ids: [ana.id], title: 'Kept' })).json.conversation
      .session_id as string;
    await purgeBotsConversations(jim.id);
    expect(await db.sessions.getById(id)).toMatchObject({ user_id: ana.id });
    expect((await call(ana, 'GET', `/api/bots/conversations/${id}`)).json.conversation.participants).toEqual([
      expect.objectContaining({ user_id: ana.id, role: 'owner' }),
    ]);
  });
});
