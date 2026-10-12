/**
 * Rooms — several people and the Agents they bring (spec 20261011-agent-first-class P5, D42–D46)
 * against real PostgreSQL with a scripted model: a room or the pair's one private chat, readable
 * and writable by its people only (super included), messages with their author, an Agent that
 * considers ordinary messages or answers an allowed target in the original author's run, another person's trigger
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
  it('lets every room Agent consider an unaddressed message and keeps irrelevant replies silent', async () => {
    const captured: CapturedTurn[] = [];
    useScript({ Ivy: [[{ text: 'I can verify the release checklist.' }]], Sage: [[{ text: '<<skip>>' }]] }, captured);
    const id = await roomWithAgents();
    await deliverToConversation(id, {
      kind: 'user_message',
      content: 'We plan to ship Monday. Anything useful to add?',
      mentions: [],
      author_user_id: ana.id,
    });
    await settled(id);
    expect(captured.map((turn) => turn.bot)).toEqual(['Ivy', 'Sage']);
    expect((await transcript(id)).filter((row) => row[0] === 'assistant')).toEqual([
      ['assistant', ivy.id, 'I can verify the release checklist.'],
    ]);
    // Ana can ask Jim's Agent about this room without borrowing Jim's private tools or memory.
    const guest = captured.find((turn) => turn.bot === 'Ivy')!.input;
    expect(Object.keys(guest.tools ?? {})).not.toContain('knowledge_query');
    expect(Object.keys(guest.tools ?? {})).not.toContain('memory');
    expect(Object.keys(guest.tools ?? {})).not.toContain('computer');
    expect(guest.systemPrompt).toContain('conversation between several people');
  });

  it('keeps explicit human, unknown and Agent addressees directed, including plain text mentions', async () => {
    const captured: CapturedTurn[] = [];
    useScript({ Ivy: [[{ text: 'Directed answer.' }]], Sage: [[{ text: 'Should stay silent.' }]] }, captured);
    const id = await roomWithAgents();
    for (const content of ['@Ana can you confirm?', '@FormerAgent please check', '@Ivy please check']) {
      await deliverToConversation(id, { kind: 'user_message', content, mentions: [], author_user_id: jim.id });
      await settled(id);
    }
    expect(captured.map((t) => t.bot)).toEqual(['Ivy']);
    expect((await transcript(id)).filter((row) => row[0] === 'assistant')).toEqual([
      ['assistant', ivy.id, 'Directed answer.'],
    ]);
  });

  it('hands a room question to a queued Agent and returns once without ping-pong', async () => {
    const captured: CapturedTurn[] = [];
    useScript(
      {
        Ivy: [
          [
            {
              toolCalls: [
                { toolName: 'team', input: { action: 'ask', bot_id: sage.id, message: 'Verify the numbers.' } },
              ],
            },
          ],
          [{ text: 'Thanks, the plan is ready.' }],
        ],
        Sage: [[{ text: 'The numbers are verified.' }]],
      },
      captured,
    );
    const id = await roomWithAgents();
    await deliverToConversation(id, {
      kind: 'user_message',
      content: 'Please review our plan together',
      mentions: [],
      author_user_id: ana.id,
    });
    await settled(id);
    expect(captured.map((t) => t.bot)).toEqual(['Ivy', 'Sage', 'Ivy']);
    expect((await transcript(id)).filter((row) => row[0] === 'assistant').map((row) => row[2])).toContain(
      'The numbers are verified.',
    );
    expect(captured[1]!.input.messages.some((m) => JSON.stringify(m.content).includes('Verify the numbers.'))).toBe(
      true,
    );
  });

  it('an Agent answers only its allowed asker, in a run that is theirs; others’ lines are information', async () => {
    const captured: CapturedTurn[] = [];
    useScript({ Ivy: [[{ text: 'Here is the summary.' }]], Sage: [[{ text: 'Numbers look fine.' }]] }, captured);
    const id = await roomWithAgents();
    const room = (await db.bots.getConversation(ana.id, id))!;
    // Owner-brought private Agents can answer through a restricted room face.
    expect(await addressableMentions(db, ana.id, room, [ivy.id, sage.id, 'nope'])).toEqual([ivy.id, sage.id]);
    const anasView = (await call(ana, 'GET', `/api/bots/conversations/${id}`)).json.conversation;
    expect(anasView.members.find((m: any) => m.bot_id === ivy.id)).toMatchObject({
      owner_user_id: jim.id,
      brought_by_user_id: jim.id,
      addressable: true,
      profile: { name: 'Ivy', role: 'Researcher' },
    });
    expect(await addressableMentions(db, jim.id, room, [ivy.id, sage.id])).toEqual([ivy.id, sage.id]);

    // Ana talks (no allowed mention): nobody answers, and no "unavailable" line either.
    await deliverToConversation(id, {
      kind: 'user_message',
      content: '@Jim I think we ship Monday',
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
      ['user', ana.id, '@Jim I think we ship Monday'],
      ['user', jim.id, '@Ivy summarize the plan'],
      ['assistant', ivy.id, 'Here is the summary.'],
    ]);
    expect(captured.map((t) => t.bot)).toEqual(['Ivy']);
    // Both people heard Jim's run, and whose it is.
    const { connectionManager } = await import('../../ws/connection-manager.js');
    const runPushes = vi
      .mocked(connectionManager.sendToUser)
      .mock.calls.filter(([, event]) => event.type === 'chat:run' && event.sessionId === id && event.userId === jim.id);
    expect(new Set(runPushes.map(([to]) => to))).toEqual(new Set([jim.id, ana.id]));
    const ivyTurn = captured[0]!.input;
    // Jim is the member; Ana's line is a participant's, and the room rules are in.
    const history = JSON.stringify(ivyTurn.messages);
    expect(history).toContain('[Ana (participant)]:');
    expect(history).toContain('[Jim (user)]:');
    expect(ivyTurn.systemPrompt).toContain('conversation between several people');
    // No hand-offs or background tasks in a room.
    expect(Object.keys(ivyTurn.tools ?? {})).toContain('team');
    expect(Object.keys(ivyTurn.tools ?? {})).not.toContain('bot_tasks');
  });

  it.each([false, true])('resumes a participant’s Agent as that participant (room busy: %s)', async (busy) => {
    const captured: CapturedTurn[] = [];
    useScript({ Sage: [[{ text: 'Continued for Ana.' }]] }, captured);
    const id = await roomWithAgents();
    const run = busy ? (await claimBotsRun(db, id, jim.id))! : null;
    await deliverToConversation(id, {
      kind: 'continue',
      botId: sage.id,
      author_user_id: ana.id,
      note: 'The member handed the computer back.',
    });
    if (run) {
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
    }
    await settled(id);
    expect(captured.map((turn) => turn.bot)).toEqual(['Sage']);
    expect(captured[0]!.input.systemPrompt).toContain('Ana');
    const { connectionManager } = await import('../../ws/connection-manager.js');
    expect(
      vi
        .mocked(connectionManager.sendToUser)
        .mock.calls.some(([, event]) => event.type === 'chat:run' && event.userId === ana.id),
    ).toBe(true);
  });

  it('does not resume a departed participant or an unidentified legacy room wake-up', async () => {
    const captured: CapturedTurn[] = [];
    useScript({ Ivy: [[{ text: 'Must not run as Jim.' }]] }, captured);
    const id = await roomWithAgents();
    await db.bots.removeParticipant(id, ana.id);
    await deliverToConversation(id, { kind: 'continue', botId: ivy.id, author_user_id: ana.id, note: 'Former member' });
    await deliverToConversation(id, { kind: 'continue', botId: ivy.id, note: 'Legacy without actor' });
    await settled(id);
    expect(captured).toEqual([]);
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

  it('records only the displayed message, advances monotonically and rejects foreign read markers', async () => {
    const id = await roomWithAgents();
    for (const content of ['first', 'second']) {
      await deliverToConversation(id, {
        kind: 'user_message',
        content: `@Ana ${content}`,
        mentions: [],
        author_user_id: jim.id,
      });
      await settled(id);
    }
    const messages = await db.sessions.getMessages(id);
    const first = messages.find((m) => m.content === '@Ana first')!;
    const second = messages.find((m) => m.content === '@Ana second')!;
    expect(
      (await call(ana, 'POST', `/api/bots/conversations/${id}/read`, { through_message_id: second.id })).status,
    ).toBe(200);
    await call(ana, 'POST', `/api/bots/conversations/${id}/read`, { through_message_id: first.id });
    const receipts = await call(jim, 'GET', `/api/bots/conversations/${id}/receipts`);
    expect(receipts.status).toBe(200);
    expect(receipts.json.people.find((p: any) => p.user_id === ana.id).through_seq).toBe(second.seq);
    expect((await call(ben, 'GET', `/api/bots/conversations/${id}/receipts`)).status).toBe(404);
    expect(
      (await call(ana, 'POST', `/api/bots/conversations/${id}/read`, { through_message_id: 'foreign-message' })).status,
    ).toBe(400);
  });

  it('tracks actual Agent processing separately from replies and silent consideration', async () => {
    const id = await roomWithAgents();
    const deps = scriptedDeps({ Ivy: [[{ text: 'Useful answer.' }]], Sage: [[{ text: '<<skip>>' }]] });
    const observed: string[][] = [];
    restoreDeps = setBotsEngineDepsForTest({
      ...deps,
      createStream: async (input) => {
        const current = await call(jim, 'GET', `/api/bots/conversations/${id}/receipts`);
        observed.push((current.json.agents ?? []).map((r: any) => r.status));
        return deps.createStream!(input);
      },
    });
    await deliverToConversation(id, {
      kind: 'user_message',
      content: 'Any useful input?',
      mentions: [],
      author_user_id: jim.id,
    });
    await settled(id);
    const receipts = (await call(ana, 'GET', `/api/bots/conversations/${id}/receipts`)).json;
    expect(observed[0]).toEqual(expect.arrayContaining(['processing', 'queued']));
    expect(receipts.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bot_id: ivy.id, status: 'answered', processed_at: expect.any(String) }),
        expect.objectContaining({ bot_id: sage.id, status: 'skipped', processed_at: expect.any(String) }),
      ]),
    );
  });

  it('expires abandoned processing receipts without marking queued work as processed', async () => {
    const id = await roomWithAgents();
    await deliverToConversation(id, {
      kind: 'user_message',
      content: '@Ana hello',
      mentions: [],
      author_user_id: jim.id,
    });
    await settled(id);
    const message = (await db.sessions.getMessages(id)).reverse().find((m) => m.role === 'user')!;
    await db.bots.setAgentReceipt(id, message.id, ivy.id, 'processing');
    await db.bots.setAgentReceipt(id, message.id, sage.id, 'queued');
    expect(await db.bots.expireAgentReceipts()).toEqual([]);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 26 * 60_000);
      expect(await db.bots.expireAgentReceipts()).toEqual([id]);
    } finally {
      vi.useRealTimers();
    }
    const receipts = (await db.bots.readReceipts(jim.id, id))!;
    expect(receipts.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bot_id: ivy.id, status: 'failed', processed_at: expect.any(String) }),
        expect.objectContaining({ bot_id: sage.id, status: 'failed', processed_at: null }),
      ]),
    );
  });

  it('exchanges a direct Agent message in a separate conversation and returns the reply to its sender', async () => {
    const fern = await db.bots.createBot({ user_id: jim.id, name: 'Fern', role: 'Reviewer' });
    const captured: CapturedTurn[] = [];
    useScript(
      {
        Ivy: [
          [
            {
              toolCalls: [
                { toolName: 'team', input: { action: 'message', bot_id: fern.id, message: 'Review release Monday.' } },
              ],
            },
          ],
          [{ text: 'Fern confirmed the release.' }],
        ],
        Fern: [[{ text: 'Monday is confirmed.' }]],
      },
      captured,
    );
    const id = await roomWithAgents();
    await deliverToConversation(id, {
      kind: 'user_message',
      content: '@Ivy ask Fern privately to review',
      mentions: [ivy.id],
      author_user_id: jim.id,
    });
    await vi.waitFor(
      async () => {
        expect((await transcript(id)).some((r) => r[2] === 'Fern confirmed the release.')).toBe(true);
      },
      { timeout: 10_000 },
    );
    await settled(id);
    expect(captured.map((t) => t.bot)).toEqual(['Ivy', 'Fern', 'Ivy']);
    const targetSession = captured[1]!.input.sessionId!;
    expect(targetSession).not.toBe(id);
    const targetRows = await db.sessions.getMessages(targetSession);
    expect(targetRows.some((m) => m.role === 'user')).toBe(false);
    expect(
      targetRows.some((m) => m.bot_event?.includes('agent_message') && m.content.includes('Review release Monday.')),
    ).toBe(true);
    expect(captured[2]!.input.messages.some((m) => JSON.stringify(m.content).includes('Monday is confirmed.'))).toBe(
      true,
    );
  }, 20_000);

  it('waits for a returned child reply to be consumed before completing its parent consultation', async () => {
    const fern = await db.bots.createBot({ user_id: jim.id, name: 'Fern' });
    const cedar = await db.bots.createBot({ user_id: jim.id, name: 'Cedar' });
    const id = await roomWithAgents();
    const parent = await db.bots.createAgentMessage({
      dedupeKey: 'parent-request',
      chainKey: 'nested-request',
      requesterId: jim.id,
      sourceSessionId: id,
      sourceBotId: ivy.id,
      targetBotId: fern.id,
      body: 'Consult Cedar first.',
    });
    const child = await db.bots.createAgentMessage({
      dedupeKey: 'child-request',
      chainKey: 'ignored-parent-key',
      parentId: parent.id,
      requesterId: jim.id,
      sourceSessionId: parent.target_session_id,
      sourceBotId: fern.id,
      targetBotId: cedar.id,
      body: 'Check this.',
    });
    await db.bots.returnAgentMessage(child.id, 'answered', 'Cedar checked it.');
    const { finishAgentMessage } = await import('../engine/agent-messages.js');
    await finishAgentMessage(db, parent.target_session_id, false);
    expect((await db.bots.getAgentMessage(parent.id))?.returned_at).toBeNull();
    expect(
      (await db.bots.listPendingInbox(parent.target_session_id)).some((item) => item.payload.includes(child.id)),
    ).toBe(true);
  });

  it('refuses private targets of another member and prevents cross-conversation cycles', async () => {
    const fern = await db.bots.createBot({ user_id: jim.id, name: 'Fern', role: 'Reviewer' });
    const captured: CapturedTurn[] = [];
    useScript(
      {
        Ivy: [
          [
            {
              toolCalls: [
                { toolName: 'team', input: { action: 'message', bot_id: sage.id, message: 'Private information?' } },
              ],
            },
            {
              toolCalls: [{ toolName: 'team', input: { action: 'message', bot_id: fern.id, message: 'Review this.' } }],
            },
          ],
          [{ text: 'Finished without a loop.' }],
        ],
        Fern: [
          [
            {
              toolCalls: [
                { toolName: 'team', input: { action: 'message', bot_id: ivy.id, message: 'Ask you again.' } },
              ],
            },
            { text: 'Cycle refused; here is my review.' },
          ],
        ],
      },
      captured,
    );
    const id = await roomWithAgents();
    await deliverToConversation(id, {
      kind: 'user_message',
      content: '@Ivy review',
      mentions: [ivy.id],
      author_user_id: jim.id,
    });
    await vi.waitFor(
      async () => expect((await transcript(id)).some((r) => r[2] === 'Finished without a loop.')).toBe(true),
      { timeout: 10_000 },
    );
    await settled(id);
    expect(captured.map((t) => t.bot)).toEqual(['Ivy', 'Fern', 'Ivy']);
    expect(await db.bots.pendingAgentMessages()).toEqual([]);
  }, 20_000);

  it('returns a revoked queued request once and never starts the revoked target', async () => {
    const fern = await db.bots.createBot({ user_id: jim.id, name: 'Fern', role: 'Reviewer' });
    const id = await roomWithAgents();
    const input = {
      dedupeKey: 'revoked-direct-request',
      chainKey: 'revoked-chain',
      requesterId: jim.id,
      sourceSessionId: id,
      sourceBotId: ivy.id,
      targetBotId: fern.id,
      body: 'Check this',
    };
    const first = await db.bots.createAgentMessage(input);
    const duplicate = await db.bots.createAgentMessage(input);
    expect(duplicate.id).toBe(first.id);
    const captured: CapturedTurn[] = [];
    useScript({ Ivy: [[{ text: 'Recipient unavailable.' }]], Fern: [[{ text: 'Must not run.' }]] }, captured);
    await db.bots.archiveBot(jim.id, fern.id);
    const { sweepInboxes } = await import('../engine/inbox.js');
    await sweepInboxes(db);
    await vi.waitFor(
      async () => expect((await transcript(id)).some((r) => r[2] === 'Recipient unavailable.')).toBe(true),
      { timeout: 10_000 },
    );
    await settled(id);
    await sweepInboxes(db);
    expect(captured.map((t) => t.bot)).toEqual(['Ivy']);
    expect((await db.bots.getAgentMessage(first.id))?.status).toBe('failed');
    const returned = (await db.sessions.getMessages(id)).filter(
      (m) => m.bot_event?.includes(first.id) && m.bot_event.includes('failed'),
    );
    expect(returned).toHaveLength(1);
  }, 20_000);

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
