/**
 * /api/bots against real PostgreSQL: owner scoping (another member's rows and
 * a super's attempts are 404), idempotent bootstrap with a fixed greeting,
 * Bot name rules, what each gallery template seeds, conversations (one Bot's
 * DM — group chats are retired and the old ones are read-only), notes,
 * exactly-once request decisions, and plant avatars (template plants, plant
 * kept and junk stripped on every write).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { insertLegacyGroup } from './helpers/legacy-group.js';
import { chatRunRegistry } from '../../chat/runs.js';
import { BOT_TEMPLATES, botTemplate } from '@greenhouse/types/bots';
import { createBotsRoutes } from '../routes.js';

vi.mock('../../ws/connection-manager.js', () => ({ connectionManager: { sendToUser: vi.fn() } }));

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
  hono.route('/api/bots', createBotsRoutes());
  return hono;
}

async function call(as: UserRow, method: string, path: string, body?: unknown) {
  const res = await app().request(`/api/bots${path}`, {
    method,
    headers: { 'x-test-user': as.id, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as Record<string, any>;
  return { status: res.status, json };
}

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const stamp = `${Date.now()}-${Math.random()}`;
  jim = await createInternalTestUser(db, { email: `jim-${stamp}@test.local`, nickname: 'Jim', role: 'team' });
  ana = await createInternalTestUser(db, { email: `ana-${stamp}@test.local`, nickname: 'Ana', role: 'team' });
  boss = await createInternalTestUser(db, { email: `boss-${stamp}@test.local`, nickname: 'Boss', role: 'super' });
  await db.users.update(jim.id, { locale: 'zh' });
});

describe('bootstrap', () => {
  it('creates Sprouty, the built-in main Bot, with a fixed greeting, once', async () => {
    const first = await call(jim, 'POST', '/bootstrap');
    expect(first.status).toBe(200);
    expect(first.json.created).toBe(true);
    expect(first.json.bot).toMatchObject({
      name: 'Sprouty',
      role: '主助手',
      template_key: 'sprouty',
      dm_session_id: first.json.dm_session_id,
    });

    const rows = await db.sessions.getMessages(first.json.dm_session_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: 'assistant', bot_id: first.json.bot.id });
    expect(JSON.parse(rows[0]!.bot_event!)).toEqual({ kind: 'greeting', bot_id: first.json.bot.id });
    expect(rows[0]!.content).toContain('你好，我是 **Sprouty**');

    const again = await call(jim, 'POST', '/bootstrap');
    expect(again.json).toMatchObject({ created: false, dm_session_id: first.json.dm_session_id });
    expect((await call(jim, 'GET', '')).json.bots).toHaveLength(1);
    expect(await db.sessions.getMessageCount(first.json.dm_session_id)).toBe(1);
  });

  it('is per member: a second member gets their own first Bot in their own locale', async () => {
    await call(jim, 'POST', '/bootstrap');
    const anas = await call(ana, 'POST', '/bootstrap');
    expect(anas.json.bot).toMatchObject({ name: 'Sprouty', role: 'Main assistant' });
    expect((await call(ana, 'GET', '')).json.bots).toHaveLength(1);
  });

  it('adds Sprouty for a member whose Bots predate it, and only once', async () => {
    const older = await call(jim, 'POST', '', { name: 'Moss' });
    expect(older.status).toBe(200);
    const first = await call(jim, 'POST', '/bootstrap');
    expect(first.json).toMatchObject({ created: true, bot: { template_key: 'sprouty' } });
    const again = await call(jim, 'POST', '/bootstrap');
    expect(again.json).toMatchObject({ created: false, bot: { id: first.json.bot.id } });
    const names = (await call(jim, 'GET', '')).json.bots.map((b: { name: string }) => b.name);
    expect(names.sort()).toEqual(['Moss', 'Sprouty']);
  });

  it('keeps Sprouty: it cannot be archived, created from a template, or created twice', async () => {
    const { json } = await call(jim, 'POST', '/bootstrap');
    const archive = await call(jim, 'DELETE', `/${json.bot.id}`);
    expect(archive).toMatchObject({ status: 400, json: { code: 'bot_protected' } });
    expect((await call(jim, 'GET', '')).json.bots.map((b: { id: string }) => b.id)).toContain(json.bot.id);
    // Only the gallery seeds Bots: Sprouty comes from bootstrap, the chief of staff is retired.
    for (const template_key of ['sprouty', 'chief'])
      expect((await call(jim, 'POST', '', { template_key })).status).toBe(400);
    // It can still be renamed and re-instructed.
    const renamed = await call(jim, 'PATCH', `/${json.bot.id}`, { name: 'Sprout' });
    expect(renamed.json.bot).toMatchObject({ name: 'Sprout', template_key: 'sprouty' });
    expect((await call(jim, 'POST', '/bootstrap')).json).toMatchObject({ created: false, bot: { id: json.bot.id } });
  });
});

describe('Bot names', () => {
  it('enforces the naming rules with machine-readable codes', async () => {
    for (const name of ['用户', 'Jim', '[Sage]', 'a：b', '']) {
      const res = await call(jim, 'POST', '', { name });
      expect(res.status).toBe(400);
      expect(res.json.code).toBe('bot_name_invalid');
    }
    expect((await call(jim, 'POST', '', { name: 'Sage' })).status).toBe(200);
    const taken = await call(jim, 'POST', '', { name: 'sage' });
    expect(taken).toMatchObject({ status: 400, json: { code: 'bot_name_taken' } });
  });

  it('numbers template copies and creates the DM with a greeting', async () => {
    const one = await call(jim, 'POST', '', { template_key: 'researcher' });
    const two = await call(jim, 'POST', '', { template_key: 'researcher' });
    expect(one.json.bot.name).toBe('蒲蒲');
    expect(two.json.bot.name).toBe('蒲蒲 2');
    expect(await db.sessions.getMessageCount(two.json.dm_session_id)).toBe(1);
  });
});

describe('gallery templates', () => {
  it('seed every gallery Bot — the computer-free examples included — from its copy, plant and greeting', async () => {
    expect(BOT_TEMPLATES.map((template) => template.key)).toEqual(
      expect.arrayContaining(['reporter', 'notetaker', 'tracker']),
    );
    for (const template of BOT_TEMPLATES) {
      const { status, json } = await call(jim, 'POST', '', { template_key: template.key });
      expect(status, template.key).toBe(200);
      const zh = template.copy.zh;
      expect(json.bot, template.key).toMatchObject({
        template_key: template.key,
        name: zh.name,
        role: zh.role,
        description: zh.pitch,
        instructions: zh.instructions,
        avatar: template.avatar,
      });
      // No Bot computer here: a computer-bound template opens with what it can do without one.
      const pitch = template.needsComputer ? zh.pitchNoComputer : zh.pitch;
      const [greeting] = await db.sessions.getMessages(json.dm_session_id);
      expect(greeting!.content, template.key).toBe(`你好，我是 **${zh.name}**，你的${zh.role}。${pitch}`);
    }

    const tracker = await call(ana, 'POST', '', { template_key: 'tracker' });
    expect(tracker.json.bot).toMatchObject({
      name: 'Maple',
      role: 'Project tracker',
      avatar: { plant: 'maple', color: 'autumn', faceStyle: 'default' },
    });
    const [hello] = await db.sessions.getMessages(tracker.json.dm_session_id);
    expect(hello!.content).toBe(`Hi, I'm **Maple**, your project tracker. ${botTemplate('tracker')!.copy.en.pitch}`);
  });
});

describe('owner scoping', () => {
  it('another member — and a super — get 404 for everything of Jim', async () => {
    const boot = await call(jim, 'POST', '/bootstrap');
    const botId = boot.json.bot.id as string;
    const sessionId = boot.json.dm_session_id as string;
    const request = await db.bots.createRequest({
      user_id: jim.id,
      session_id: sessionId,
      bot_id: botId,
      kind: 'approval',
      payload: { action: 'tool_call', title: 'x', details: [], allow_always: false },
    });
    for (const intruder of [ana, boss]) {
      expect((await call(intruder, 'GET', `/conversations/${sessionId}`)).status).toBe(404);
      expect((await call(intruder, 'PATCH', `/${botId}`, { role: 'pwned' })).status).toBe(404);
      expect((await call(intruder, 'DELETE', `/${botId}`)).status).toBe(404);
      expect((await call(intruder, 'POST', `/conversations/${sessionId}/notes`, { title: 'x' })).status).toBe(404);
      expect((await call(intruder, 'POST', `/requests/${request.id}`, { decision: 'approve' })).status).toBe(404);
      expect((await call(intruder, 'POST', '/conversations', { bot_ids: [botId] })).status).toBe(404);
      expect((await call(intruder, 'GET', '/conversations')).json.conversations).toHaveLength(0);
    }
    expect((await db.bots.getRequest(jim.id, request.id))?.status).toBe('pending');
  });
});

describe('conversations', () => {
  it('opens a Bot’s DM, lists it with attention, pages its messages with parsed events', async () => {
    const ivy = (await call(jim, 'POST', '', { name: 'Ivy' })).json.bot;
    const fern = (await call(jim, 'POST', '', { name: 'Fern' })).json.bot;
    const opened = await call(jim, 'POST', '/conversations', { bot_ids: [ivy.id] });
    expect(opened.status).toBe(200);
    const dm = opened.json.conversation;
    expect(dm).toMatchObject({ kind: 'direct', owner_bot_id: ivy.id, lead_bot_id: ivy.id, allow_bot_chat: true });
    expect(dm.session_id).toBe(ivy.dm_session_id);
    expect(dm.context.threshold).toBe(24_000);
    await call(jim, 'POST', `/conversations/${dm.session_id}/members`, { bot_id: fern.id });

    await db.sessions.addMessage({ session_id: dm.session_id, role: 'user', content: 'hi' });
    await db.sessions.addMessage({
      session_id: dm.session_id,
      role: 'system',
      content: 'Ivy → @Fern：go',
      bot_id: ivy.id,
      bot_event: JSON.stringify({ kind: 'ask', from: ivy.id, to: fern.id }),
    });
    await db.sessions.addMessage({ session_id: dm.session_id, role: 'assistant', content: 'done', bot_id: fern.id });

    const list = await call(jim, 'GET', '/conversations');
    const row = list.json.conversations.find((c: { session_id: string }) => c.session_id === dm.session_id);
    expect(row).toMatchObject({ attention: 'unread', last_message: { preview: 'done', bot_id: fern.id } });
    // Bot replies only: Ivy's greeting and Fern's "done" — not the user turn, not the hand-off event.
    expect(row.unread_count).toBe(2);

    const page = await call(jim, 'GET', `/conversations/${dm.session_id}?limit=2`);
    expect(page.json.has_more).toBe(true);
    expect(page.json.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'assistant']);
    expect(page.json.messages[0].bot_event).toEqual({ kind: 'ask', from: ivy.id, to: fern.id });

    expect((await call(jim, 'POST', `/conversations/${dm.session_id}/read`)).json).toEqual({ ok: true });
    const after = await call(jim, 'GET', '/conversations');
    const read = after.json.conversations.find((c: { session_id: string }) => c.session_id === dm.session_id);
    expect(read).toMatchObject({ attention: 'idle', unread_count: 0 });
  });

  it('takes exactly one Bot id: none or several is 400 groups_retired and creates nothing', async () => {
    const ivy = (await call(jim, 'POST', '', { name: 'Ivy' })).json.bot;
    const fern = (await call(jim, 'POST', '', { name: 'Fern' })).json.bot;
    const before = (await call(jim, 'GET', '/conversations')).json.conversations.length;
    for (const bot_ids of [[ivy.id, fern.id], [], [ivy.id, fern.id, ivy.id]]) {
      const res = await call(jim, 'POST', '/conversations', { bot_ids, title: 'Launch' });
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ code: 'groups_retired' });
      expect(typeof res.json.error).toBe('string');
    }
    expect((await call(jim, 'POST', '/conversations', { bot_ids: 'nope' })).status).toBe(400);
    // The same id twice is still one Bot: its DM.
    const same = await call(jim, 'POST', '/conversations', { bot_ids: [ivy.id, ivy.id] });
    expect(same.json.conversation).toMatchObject({ kind: 'direct', owner_bot_id: ivy.id });
    expect((await call(jim, 'GET', '/conversations')).json.conversations).toHaveLength(before);
  });

  it('keeps a DM a DM: invited Bots are guests, its owner stays, nothing to edit', async () => {
    const ivy = (await call(jim, 'POST', '', { name: 'Ivy' })).json;
    const sage = (await call(jim, 'POST', '', { name: 'Sage' })).json.bot;
    const added = await call(jim, 'POST', `/conversations/${ivy.dm_session_id}/members`, { bot_id: sage.id });
    expect(added.status).toBe(200);
    expect(added.json.conversation.kind).toBe('direct');
    expect(added.json.conversation.members.map((m: { role: string }) => m.role)).toEqual(['owner', 'guest']);
    // There is nothing to edit on a conversation any more: the PATCH route is gone.
    const patch = await app().request(`/api/bots/conversations/${ivy.dm_session_id}`, {
      method: 'PATCH',
      headers: { 'x-test-user': jim.id, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', allow_bot_chat: false }),
    });
    expect(patch.status).toBe(404);
    expect((await call(jim, 'DELETE', `/conversations/${ivy.dm_session_id}/members/${ivy.bot.id}`)).status).toBe(400);
    const rows = await db.sessions.getMessages(ivy.dm_session_id);
    expect(JSON.parse(rows.at(-1)!.bot_event!)).toMatchObject({ kind: 'joined', bot_id: sage.id, by: 'user' });
  });

  it('refuses a manual compaction while a Bot is replying', async () => {
    const ivy = (await call(jim, 'POST', '', { name: 'Ivy' })).json;
    const run = chatRunRegistry.claim(ivy.dm_session_id, jim.id)!;
    try {
      expect((await call(jim, 'POST', `/conversations/${ivy.dm_session_id}/compact`)).status).toBe(409);
    } finally {
      chatRunRegistry.release(run);
    }
    const idle = await call(jim, 'POST', `/conversations/${ivy.dm_session_id}/compact`);
    expect(idle).toMatchObject({ status: 200, json: { digest: null } });
  });

  it('manages shared notes', async () => {
    const ivy = (await call(jim, 'POST', '', { name: 'Ivy' })).json;
    const path = `/conversations/${ivy.dm_session_id}/notes`;
    expect((await call(jim, 'POST', path, { title: '' })).status).toBe(400);
    const note = (await call(jim, 'POST', path, { title: 'Budget is 5k', pinned: true })).json.note;
    expect(note).toMatchObject({ title: 'Budget is 5k', pinned: true, status: 'open', author_bot_id: null });
    expect((await call(jim, 'PATCH', `${path}/${note.id}`, { status: 'done' })).json.note.status).toBe('done');
    expect((await call(jim, 'GET', path)).json.notes).toHaveLength(1);
    expect((await call(jim, 'DELETE', `${path}/${note.id}`)).json).toEqual({ ok: true });
    expect((await call(jim, 'DELETE', `${path}/${note.id}`)).status).toBe(404);
  });

  it('lists no background tasks for a fresh conversation and 404s an unknown cancel', async () => {
    const ivy = (await call(jim, 'POST', '', { name: 'Ivy' })).json;
    expect((await call(jim, 'GET', `/conversations/${ivy.dm_session_id}/tasks`)).json).toEqual({ tasks: [] });
    expect((await call(jim, 'POST', '/tasks/nope/cancel')).status).toBe(404);
  });
});

describe('requests', () => {
  it('settles an approval exactly once', async () => {
    const ivy = (await call(jim, 'POST', '', { name: 'Ivy' })).json;
    const request = await db.bots.createRequest({
      user_id: jim.id,
      session_id: ivy.dm_session_id,
      bot_id: ivy.bot.id,
      kind: 'approval',
      payload: { action: 'tool_call', title: 'Save', details: [], allow_always: false },
    });
    expect((await call(jim, 'GET', '/requests?status=pending')).json.requests).toHaveLength(1);
    const first = await call(jim, 'POST', `/requests/${request.id}`, { decision: 'deny' });
    expect(first).toMatchObject({ status: 200, json: { request: { status: 'denied' } } });
    const again = await call(jim, 'POST', `/requests/${request.id}`, { decision: 'approve' });
    expect(again).toMatchObject({ status: 409, json: { code: 'already_decided' } });
    expect((await call(jim, 'POST', `/requests/${request.id}`, { decision: 'maybe' })).status).toBe(400);
  });

  it('a second click while the first decision is still in flight is 409 deciding', async () => {
    const ivy = (await call(jim, 'POST', '', { name: 'Ivy' })).json;
    const request = await db.bots.createRequest({
      user_id: jim.id,
      session_id: ivy.dm_session_id,
      bot_id: ivy.bot.id,
      kind: 'approval',
      payload: { action: 'tool_call', title: 'Save', details: [], allow_always: false },
    });
    // Hold the first decision at its settle until the second click has answered.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const settle = db.bots.settleRequest.bind(db.bots);
    vi.spyOn(db.bots, 'settleRequest').mockImplementationOnce(async (...args) => {
      await gate;
      return settle(...args);
    });
    const first = call(jim, 'POST', `/requests/${request.id}`, { decision: 'approve' });
    await vi.waitFor(() => expect(db.bots.settleRequest).toHaveBeenCalled());
    const second = await call(jim, 'POST', `/requests/${request.id}`, { decision: 'deny' });
    expect(second).toMatchObject({ status: 409, json: { code: 'deciding' } });
    release();
    expect(await first).toMatchObject({ status: 200, json: { request: { status: 'resolved' } } });
  });

  it('starting a task whose proposing Bot is gone is 409 bot_gone, and the card stays open', async () => {
    const ivy = (await call(jim, 'POST', '', { name: 'Ivy' })).json;
    const request = await db.bots.createRequest({
      user_id: jim.id,
      session_id: ivy.dm_session_id,
      bot_id: ivy.bot.id,
      kind: 'task_start',
      payload: { title: 'Check links', brief: 'b' },
    });
    await db.bots.archiveBot(jim.id, ivy.bot.id);
    const res = await call(jim, 'POST', `/requests/${request.id}`, { decision: 'approve' });
    expect(res).toMatchObject({ status: 409, json: { code: 'bot_gone' } });
    expect((await db.bots.getRequest(jim.id, request.id))?.status).toBe('pending');
  });

  it('a confirmed Bot proposal creates the Bot with the member’s edits, joins it, wakes the proposer', async () => {
    const ivy = (await call(jim, 'POST', '', { name: 'Ivy' })).json;
    const request = await db.bots.createRequest({
      user_id: jim.id,
      session_id: ivy.dm_session_id,
      bot_id: ivy.bot.id,
      kind: 'bot_create',
      payload: { name: 'Writer', role: 'Writer', instructions: 'Write well.', avatar: {}, template_key: null },
    });
    const bad = await call(jim, 'POST', `/requests/${request.id}`, { decision: 'approve', bot: { name: 'Jim' } });
    expect(bad).toMatchObject({ status: 400, json: { code: 'bot_name_invalid' } });

    const ok = await call(jim, 'POST', `/requests/${request.id}`, { decision: 'approve', bot: { name: '小文' } });
    expect(ok.status).toBe(200);
    expect(ok.json.request.status).toBe('resolved');
    const newBotId = ok.json.request.result.bot_id as string;
    const created = await db.bots.getBot(jim.id, newBotId);
    expect(created).toMatchObject({ name: '小文', role: 'Writer', instructions: 'Write well.' });

    const dm = await db.bots.getConversation(jim.id, ivy.dm_session_id);
    expect(dm?.members.find((m) => m.bot_id === newBotId)?.role).toBe('guest');
    const rows = await db.sessions.getMessages(ivy.dm_session_id);
    expect(rows.map((r) => (r.bot_event ? JSON.parse(r.bot_event).kind : r.role))).toEqual(['greeting', 'created']);
    // The proposer's wake-up (with the "joined" line) waits for the engine.
    const inbox = await db.bots.listPendingInbox(ivy.dm_session_id);
    expect(inbox.map((item) => item.kind)).toEqual(['continue']);
    expect(JSON.parse(inbox[0]!.payload)).toMatchObject({ kind: 'continue', botId: ivy.bot.id });

    expect((await call(jim, 'POST', `/requests/${request.id}`, { decision: 'approve' })).status).toBe(409);
    expect((await call(jim, 'GET', '')).json.bots.map((b: { name: string }) => b.name)).toContain('小文');
  });
});

describe('retired group chats', () => {
  async function legacyGroup() {
    const ivy = (await call(jim, 'POST', '', { name: 'Ivy' })).json.bot;
    const fern = (await call(jim, 'POST', '', { name: 'Fern' })).json.bot;
    const sage = (await call(jim, 'POST', '', { name: 'Sage' })).json.bot;
    const sessionId = await insertLegacyGroup(db, {
      userId: jim.id,
      botIds: [ivy.id, fern.id],
      title: 'Launch',
      description: 'Reply in bullet points.',
      allowBotChat: false,
    });
    return { ivy, fern, sage, sessionId };
  }

  it('stay readable: listed and paged, the deprecated switch reported as true', async () => {
    const { ivy, fern, sessionId } = await legacyGroup();
    await db.sessions.addMessage({ session_id: sessionId, role: 'assistant', content: 'old answer', bot_id: fern.id });
    const listed = (await call(jim, 'GET', '/conversations')).json.conversations;
    expect(listed.find((c: { session_id: string }) => c.session_id === sessionId)).toMatchObject({
      kind: 'group',
      title: 'Launch',
    });
    const detail = await call(jim, 'GET', `/conversations/${sessionId}`);
    expect(detail.status).toBe(200);
    expect(detail.json.conversation).toMatchObject({
      kind: 'group',
      lead_bot_id: ivy.id,
      description: 'Reply in bullet points.',
      allow_bot_chat: true,
    });
    expect(detail.json.messages.map((m: { content: string }) => m.content)).toEqual(['old answer']);
  });

  it('take no invites or removals: 409 group_closed, the roster unchanged', async () => {
    const { ivy, fern, sage, sessionId } = await legacyGroup();
    const invite = await call(jim, 'POST', `/conversations/${sessionId}/members`, { bot_id: sage.id });
    expect(invite).toMatchObject({ status: 409, json: { code: 'group_closed' } });
    const remove = await call(jim, 'DELETE', `/conversations/${sessionId}/members/${fern.id}`);
    expect(remove).toMatchObject({ status: 409, json: { code: 'group_closed' } });
    const roster = (await db.bots.getConversation(jim.id, sessionId))!.members.map((m) => [m.bot_id, m.role]);
    expect(roster).toEqual([
      [ivy.id, 'lead'],
      [fern.id, 'member'],
    ]);
    expect(await db.sessions.getMessageCount(sessionId)).toBe(0);
    // Another member still gets 404, not a hint that the conversation exists.
    expect((await call(ana, 'POST', `/conversations/${sessionId}/members`, { bot_id: sage.id })).status).toBe(404);
  });

  it('cards there cannot be decided: 409 group_closed, a pending one is withdrawn', async () => {
    const { ivy, sessionId } = await legacyGroup();
    const card = await db.bots.createRequest({
      user_id: jim.id,
      session_id: sessionId,
      bot_id: ivy.id,
      kind: 'bot_create',
      payload: { name: 'Writer', role: 'Writer', instructions: 'Write well.', avatar: {}, template_key: null },
    });
    const res = await call(jim, 'POST', `/requests/${card.id}`, { decision: 'approve' });
    expect(res).toMatchObject({ status: 409, json: { code: 'group_closed' } });
    expect(await db.bots.getRequest(jim.id, card.id)).toMatchObject({ status: 'canceled' });
    expect((await call(jim, 'GET', '')).json.bots.map((b: { name: string }) => b.name)).not.toContain('Writer');
    // Already withdrawn (or cancelled by migration 0015): still group_closed, not already_decided.
    expect(await call(jim, 'POST', `/requests/${card.id}`, { decision: 'deny' })).toMatchObject({
      status: 409,
      json: { code: 'group_closed' },
    });
    expect((await call(jim, 'GET', '/requests?status=pending')).json.requests).toHaveLength(0);
  });
});

describe('archived Bots and memory receipts', () => {
  it('lists archived Bots separately, each with its readable DM', async () => {
    const ivy = (await call(jim, 'POST', '', { name: 'Ivy' })).json;
    const fern = (await call(jim, 'POST', '', { name: 'Fern' })).json;
    expect((await call(jim, 'DELETE', `/${fern.bot.id}`)).status).toBe(200);
    const overview = (await call(jim, 'GET', '')).json;
    expect(overview.bots.map((b: { id: string }) => b.id)).toEqual([ivy.bot.id]);
    expect(overview.archived_bots).toEqual([
      expect.objectContaining({ id: fern.bot.id, status: 'archived', dm_session_id: fern.dm_session_id }),
    ]);
    // Another member sees none of it.
    expect((await call(ana, 'GET', '')).json).toMatchObject({ bots: [], archived_bots: [] });
  });

  it('returns the current status of every memory a memory step on the page wrote', async () => {
    const ivy = (await call(jim, 'POST', '', { name: 'Ivy' })).json;
    const kept = await db.userMemories.create({ user_id: jim.id, category: 'fact', title: 'kept', content: 'k' });
    const undone = await db.userMemories.create({ user_id: jim.id, category: 'fact', title: 'undone', content: 'u' });
    await db.userMemories.setStatus(undone.id, jim.id, 'archived');
    const anas = await db.userMemories.create({ user_id: ana.id, category: 'fact', title: 'ana', content: 'a' });
    const remember = (id: number, asText = false) => {
      const output = { action: 'remember', scope: 'user', remembered: { id, title: 't' } };
      return { step: 1, tool: 'memory', input: {}, output: asText ? JSON.stringify(output) : output, duration_ms: 1 };
    };
    await db.sessions.addMessage({
      session_id: ivy.dm_session_id,
      role: 'assistant',
      content: 'Noted.',
      bot_id: ivy.bot.id,
      pipeline: [remember(kept.id), remember(undone.id, true), remember(999_999_999), remember(anas.id)],
    });
    const page = (await call(jim, 'GET', `/conversations/${ivy.dm_session_id}`)).json;
    expect(page.memory_states).toEqual({
      [String(kept.id)]: 'active',
      [String(undone.id)]: 'archived',
      '999999999': 'deleted',
      // Another member's memory id reads as gone, never as its real status.
      [String(anas.id)]: 'deleted',
    });
    expect(page.messages.map((m: { role: string }) => m.role)).toEqual(['assistant', 'assistant']);

    // A page with no memory step carries no map at all.
    const fern = (await call(jim, 'POST', '', { name: 'Fern' })).json;
    expect((await call(jim, 'GET', `/conversations/${fern.dm_session_id}`)).json).not.toHaveProperty('memory_states');
  });
});

describe('Bot profile', () => {
  it('edits, archives and lists a Bot’s private memories', async () => {
    const ivy = (await call(jim, 'POST', '', { name: 'Ivy' })).json.bot;
    const patched = await call(jim, 'PATCH', `/${ivy.id}`, { role: 'Coordinator', model_id: 'not-a-model' });
    expect(patched.status).toBe(400);
    expect((await call(jim, 'PATCH', `/${ivy.id}`, { role: 'Coordinator', name: 'Ivy Two' })).json.bot).toMatchObject({
      role: 'Coordinator',
      name: 'Ivy Two',
    });
    const mine = await db.userMemories.create({
      user_id: jim.id,
      category: 'fact',
      title: 'private',
      content: 'p',
      bot_id: ivy.id,
    });
    const shared = await db.userMemories.create({ user_id: jim.id, category: 'fact', title: 'shared', content: 's' });
    const fern = (await call(jim, 'POST', '', { name: 'Fern' })).json.bot;
    const fernsOwn = await db.userMemories.create({
      user_id: jim.id,
      category: 'fact',
      title: 'fern private',
      content: 'f',
      bot_id: fern.id,
    });
    const memories = await call(jim, 'GET', `/${ivy.id}/memories`);
    expect(memories.json.memories.map((m: { title: string }) => m.title)).toEqual(['private']);
    // Ivy's profile can delete only Ivy's private notes: not another Bot's, not the shared layer.
    expect((await call(jim, 'DELETE', `/${ivy.id}/memories/${fernsOwn.id}`)).status).toBe(404);
    expect((await call(jim, 'DELETE', `/${ivy.id}/memories/${shared.id}`)).status).toBe(404);
    expect(await db.userMemories.getById(fernsOwn.id)).toBeDefined();
    expect(await db.userMemories.getById(shared.id)).toBeDefined();
    expect((await call(ana, 'DELETE', `/${ivy.id}/memories/${mine.id}`)).status).toBe(404);
    expect((await call(jim, 'DELETE', `/${ivy.id}/memories/${mine.id}`)).json).toEqual({ ok: true });
    expect((await call(jim, 'DELETE', `/${ivy.id}`)).json).toEqual({ ok: true });
    expect((await call(jim, 'GET', '')).json.bots).toHaveLength(1);
  });
});

describe('Bot avatars', () => {
  it('a template copy is the plant the template is named after', async () => {
    const boot = await call(jim, 'POST', '/bootstrap');
    // Tracks the template (not a copy of its values), so a template edit cannot strand this test.
    expect(boot.json.bot.avatar).toEqual(botTemplate('sprouty')!.avatar);
    expect(boot.json.bot.avatar.plant).toBe('sprout');
    const researcher = await call(jim, 'POST', '', { template_key: 'researcher' });
    expect(researcher.json.bot.avatar).toEqual({ plant: 'dandelion', color: 'sunshine', faceStyle: 'default' });
    const stored = await db.bots.getBot(jim.id, researcher.json.bot.id);
    expect(JSON.parse(stored!.avatar)).toEqual({ plant: 'dandelion', color: 'sunshine', faceStyle: 'default' });
  });

  it('create and patch keep the plant and mood, strip unknown keys, reject out-of-bounds values', async () => {
    const created = await call(jim, 'POST', '', {
      name: 'Lotus',
      avatar: { plant: 'lotus', mood: 'soft', color: 'blossom', eyeStyle: 'soft', sparkles: true },
    });
    expect(created.status).toBe(200);
    expect(created.json.bot.avatar).toEqual({ plant: 'lotus', mood: 'soft', color: 'blossom', eyeStyle: 'soft' });

    const botId = created.json.bot.id as string;
    const patched = await call(jim, 'PATCH', `/${botId}`, { avatar: { plant: 'maple', mood: 'bright', model: 'x' } });
    expect(patched.json.bot.avatar).toEqual({ plant: 'maple', mood: 'bright' });
    expect((await call(jim, 'GET', '')).json.bots.find((b: { id: string }) => b.id === botId).avatar).toEqual({
      plant: 'maple',
      mood: 'bright',
    });

    const tooLong = await call(jim, 'PATCH', `/${botId}`, { avatar: { plant: 'x'.repeat(41) } });
    expect(tooLong).toMatchObject({ status: 400, json: { code: 'bot_name_invalid' } });
    expect(JSON.parse((await db.bots.getBot(jim.id, botId))!.avatar)).toEqual({ plant: 'maple', mood: 'bright' });
  });

  it('a confirmed Bot proposal keeps the proposed plant, or the member’s pick on the card', async () => {
    const ivy = (await call(jim, 'POST', '', { name: 'Ivy' })).json;
    const propose = (name: string) =>
      db.bots.createRequest({
        user_id: jim.id,
        session_id: ivy.dm_session_id,
        bot_id: ivy.bot.id,
        kind: 'bot_create',
        payload: {
          name,
          role: 'Writer',
          instructions: 'Write well.',
          avatar: { plant: 'clover', color: 'forest' },
          template_key: null,
        },
      });
    const asProposed = await call(jim, 'POST', `/requests/${(await propose('Clover')).id}`, { decision: 'approve' });
    const kept = await db.bots.getBot(jim.id, asProposed.json.request.result.bot_id);
    expect(JSON.parse(kept!.avatar)).toEqual({ plant: 'clover', color: 'forest' });

    const edited = await call(jim, 'POST', `/requests/${(await propose('Lavender')).id}`, {
      decision: 'approve',
      bot: { avatar: { plant: 'lavender', color: 'lavender', faceStyle: 'sleepy', junk: 1 } },
    });
    const picked = await db.bots.getBot(jim.id, edited.json.request.result.bot_id);
    expect(JSON.parse(picked!.avatar)).toEqual({ plant: 'lavender', color: 'lavender', faceStyle: 'sleepy' });
  });
});
