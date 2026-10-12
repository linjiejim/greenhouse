/**
 * Public Agents (spec 20261011-agent-first-class P4, D33–D41) against real PostgreSQL: publishing
 * rules, the audience-filtered directory, a member's own DM with someone else's Agent, the narrow
 * public face in a real run (published version, whom it serves, no member notes or user-level
 * memory, granted knowledge only), its own budget account, availability as the owner or an
 * administrator changes it, feedback the owner sees without the conversation, and no guests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type BotRow, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { PLATFORM_ORG_ID, initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { knowledgeRegistration } from '../../platform/knowledge/registration.js';
import { runInAgentScope } from '../../platform/agent-scope.js';
import { chatRunRegistry } from '../../chat/runs.js';
import { reserveAgentTokenBudget } from '../../llm/usage-budget.js';
import { runBotsRun } from '../engine/chain.js';
import { setBotsEngineDepsForTest } from '../engine/deps.js';
import { conversationReplyState } from '../engine/index.js';
import { createGrantedKnowledgeTool } from '../engine/public-face.js';
import { scriptedDeps, type CapturedTurn } from '../engine/__tests__/scripted-model.js';
import { grantedFolderIds, publicationOf, publicBotFor } from '../public.js';
import { createAdminAgentsRoutes, createAgentsDirectoryRoutes } from '../public-routes.js';
import { createBotsRoutes } from '../routes.js';
import { ensureSproutyBot } from '../sprouty.js';

vi.mock('../../ws/connection-manager.js', () => ({ connectionManager: { sendToUser: vi.fn() } }));

let db: DatabaseProvider;
let jim: UserRow; // the owner
let ana: UserRow; // in the audience
let ben: UserRow; // not in it
let boss: UserRow; // an administrator
let helpdesk: BotRow;
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
  hono.route('/api/agents', createAgentsDirectoryRoutes());
  hono.route('/api/admin/agents', createAdminAgentsRoutes());
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
  initializePlatformRuntime(db, [knowledgeRegistration]);
  const stamp = `${Date.now()}-${Math.random()}`;
  jim = await createInternalTestUser(db, { email: `pub-jim-${stamp}@test.local`, nickname: 'Jim', role: 'team' });
  ana = await createInternalTestUser(db, { email: `pub-ana-${stamp}@test.local`, nickname: 'Ana', role: 'team' });
  ben = await createInternalTestUser(db, { email: `pub-ben-${stamp}@test.local`, nickname: 'Ben', role: 'team' });
  boss = await createInternalTestUser(db, { email: `pub-boss-${stamp}@test.local`, nickname: 'Boss', role: 'super' });
  helpdesk = await db.bots.createBot({
    user_id: jim.id,
    name: 'Helpdesk',
    role: 'IT support',
    instructions: 'Answer IT questions from the handbook. VERSION-ONE.',
  });
});

afterEach(() => {
  resetPlatformRuntimeForTests();
  restoreDeps?.();
  restoreDeps = null;
});

async function publishToAna() {
  return call(jim, 'PUT', `/api/bots/${helpdesk.id}/publication`, {
    visibility: 'public',
    publish: true,
    audience: { everyone: false, user_ids: [ana.id], group_ids: [] },
  });
}

describe('publishing (owner)', () => {
  it('never publishes the main Agent, needs a published version, and validates the audience', async () => {
    const sprouty = await ensureSproutyBot(db, jim.id);
    const refused = await call(jim, 'PUT', `/api/bots/${sprouty.id}/publication`, {
      visibility: 'public',
      publish: true,
    });
    expect(refused).toMatchObject({ status: 400, json: { code: 'bot_protected' } });
    expect((await call(jim, 'PUT', `/api/bots/${helpdesk.id}/publication`, { visibility: 'public' })).status).toBe(400);
    expect(
      (
        await call(jim, 'PUT', `/api/bots/${helpdesk.id}/publication`, {
          audience: { everyone: false, user_ids: ['nobody'], group_ids: [] },
        })
      ).status,
    ).toBe(400);

    const published = await publishToAna();
    expect(published.status).toBe(200);
    expect(published.json).toMatchObject({
      visibility: 'public',
      published_version: 1,
      audience: { everyone: false, user_ids: [ana.id], group_ids: [] },
      grants: { kb_folder_ids: [], computer: false },
      users: 0,
    });
    // Someone else's Agent: not theirs to publish.
    expect((await call(ana, 'PUT', `/api/bots/${helpdesk.id}/publication`, { visibility: 'private' })).status).toBe(
      404,
    );
  });
});

describe('using a public Agent (member)', () => {
  it('lists it to its audience only, and opens the member’s own DM with a greeting', async () => {
    await publishToAna();
    expect((await call(ana, 'GET', '/api/agents')).json.agents).toEqual([
      expect.objectContaining({
        id: helpdesk.id,
        name: 'Helpdesk',
        owner: { id: jim.id, nickname: 'Jim' },
        available: true,
      }),
    ]);
    expect((await call(ben, 'GET', '/api/agents')).json.agents).toEqual([]);
    expect((await call(jim, 'GET', '/api/agents')).json.agents).toEqual([]); // their own: used directly
    expect((await call(ben, 'POST', `/api/agents/${helpdesk.id}/conversation`)).status).toBe(404);

    const opened = await call(ana, 'POST', `/api/agents/${helpdesk.id}/conversation`);
    expect(opened.status).toBe(201);
    const dm = opened.json.conversation_id as string;
    expect((await call(ana, 'POST', `/api/agents/${helpdesk.id}/conversation`)).json.conversation_id).toBe(dm);
    // The owner's own DM is a different conversation; the owner cannot read Ana's.
    const jimsDm = await db.bots.ensureDirectConversation(jim.id, helpdesk.id);
    expect(jimsDm.session_id).not.toBe(dm);
    expect((await call(jim, 'GET', `/api/bots/conversations/${dm}`)).status).toBe(404);
    const [greeting] = await db.sessions.getMessages(dm);
    expect(greeting).toMatchObject({ role: 'assistant', bot_id: helpdesk.id });
    expect(greeting!.content).not.toMatch(/your it support/i);

    // Her Agents list names it for her threads; no guests can join it.
    const list = await call(ana, 'GET', '/api/bots');
    expect(list.json.shared_bots).toEqual([
      expect.objectContaining({
        id: helpdesk.id,
        dm_session_id: dm,
        available: true,
        owner: { id: jim.id, nickname: 'Jim' },
        computer: false,
      }),
    ]);
    const anaBot = await db.bots.createBot({ user_id: ana.id, name: 'Ivy', role: '' });
    const invite = await call(ana, 'POST', `/api/bots/conversations/${dm}/members`, { bot_id: anaBot.id });
    expect(invite).toMatchObject({ status: 409, json: { code: 'public_agent' } });
  });

  it('answers on its public face: the published version, whom it serves, nothing personal of either side', async () => {
    await publishToAna();
    // A later edit is not published yet: Ana still talks to version 1.
    await db.bots.updateBot(jim.id, helpdesk.id, { instructions: 'VERSION-TWO', created_by: jim.id });
    await db.users.update(ana.id, { notes: 'ANA-PRIVATE-NOTE' });
    await db.userMemories.create({
      user_id: ana.id,
      category: 'fact',
      title: 'ANA-USER-MEMORY',
      content: 'x',
      source: 'user',
    });
    const dm = (await call(ana, 'POST', `/api/agents/${helpdesk.id}/conversation`)).json.conversation_id as string;
    await db.sessions.addMessage({ session_id: dm, role: 'user', content: 'My laptop will not start' });

    const captured: CapturedTurn[] = [];
    restoreDeps = setBotsEngineDepsForTest(
      scriptedDeps({ Helpdesk: [[{ text: 'Hold the power button for 10 s.' }]] }, captured),
    );
    const run = chatRunRegistry.claim(dm, ana.id)!;
    const latest = await db.sessions.getLatestMessage(dm);
    await runBotsRun({
      run,
      userId: ana.id,
      sessionId: dm,
      toolRegistry: {},
      trigger: { kind: 'message', reason: 'user', mentions: [] },
      triggerKey: latest!.id,
      db,
    });

    expect(captured).toHaveLength(1);
    const { systemPrompt, tools, messages } = captured[0]!.input;
    expect(systemPrompt).toContain('VERSION-ONE');
    expect(systemPrompt).not.toContain('VERSION-TWO');
    expect(systemPrompt).toMatch(/published for colleagues\. You are now helping Ana — not Jim/);
    expect(systemPrompt).not.toContain('ANA-PRIVATE-NOTE');
    expect(JSON.stringify(messages)).not.toContain('ANA-USER-MEMORY');
    expect(Object.keys(tools ?? {}).sort()).toEqual(['conversation', 'knowledge_query', 'memory', 'team']);
    const rows = await db.sessions.getMessages(dm);
    expect(rows.at(-1)).toMatchObject({
      role: 'assistant',
      bot_id: helpdesk.id,
      content: 'Hold the power button for 10 s.',
    });
  });

  it('reads only the granted folders, as its owner reads them', async () => {
    const handbook = await db.drive.createFolder({
      scope: 'kb',
      name: 'Handbook',
      visibility: 'private',
      owner_user_id: jim.id,
    });
    const diary = await db.drive.createFolder({
      scope: 'kb',
      name: 'Diary',
      visibility: 'private',
      owner_user_id: jim.id,
    });
    const stamp = Date.now();
    await db.knowledgeBase.create({
      doc_id: `vpn-${stamp}`,
      title: 'VPN setup',
      content: 'Install the VPN client and sign in with SSO.',
      visibility: 'private',
      status: 'published',
      folder_id: handbook.id,
      owner_user_id: jim.id,
    });
    const secret = await db.knowledgeBase.create({
      doc_id: `diary-${stamp}`,
      title: 'Private diary',
      content: 'SECRET',
      visibility: 'private',
      status: 'published',
      folder_id: diary.id,
      owner_user_id: jim.id,
    });
    // Ana's folder is not Jim's to grant.
    const anas = await db.drive.createFolder({
      scope: 'kb',
      name: 'Mine',
      visibility: 'private',
      owner_user_id: ana.id,
    });
    const refused = await call(jim, 'PUT', `/api/bots/${helpdesk.id}/publication`, {
      grants: { kb_folder_ids: [anas.id] },
    });
    expect(refused.status).toBe(400);
    expect(
      (await call(jim, 'PUT', `/api/bots/${helpdesk.id}/publication`, { grants: { kb_folder_ids: [handbook.id] } }))
        .status,
    ).toBe(200);

    const bot = (await db.bots.getBot(jim.id, helpdesk.id))!;
    const folderIds = await grantedFolderIds(db, bot, publicationOf(bot));
    expect(folderIds).toEqual([handbook.id]);
    await publishToAna();
    const knowledge = createGrantedKnowledgeTool(db, bot, ana.id) as unknown as {
      execute: (input: Record<string, unknown>, options: unknown) => Promise<Record<string, any>>;
    };
    const listed = await knowledge.execute({ action: 'list' }, {});
    expect(listed.results.map((r: { title: string }) => r.title)).toEqual(['VPN setup']);
    expect(await knowledge.execute({ action: 'get', id: secret.id }, {})).toMatchObject({
      error: expect.stringContaining('No document'),
    });
  });

  it('charges its own budget account, not the member’s', async () => {
    const lease = await reserveAgentTokenBudget({
      db,
      userId: ana.id,
      caller: 'bots-turn',
      estimatedTokens: 500,
      agent: { botId: helpdesk.id, monthlyTokens: 10_000 },
    });
    await lease.settle(420);
    const reservations = await db.usageBudget.getReservationGroup(lease.idempotencyKey);
    const accounts = await Promise.all(reservations.map((row) => db.usageBudget.getAccount(row.account_id)));
    const agent = accounts.find((account) => account?.scope_type === 'agent');
    expect(agent).toMatchObject({ scope_id: helpdesk.id, limit_units: 10_000, spent_units: 420 });
    // The member's personal account is not part of it.
    expect(accounts.some((account) => account?.scope_type === 'user')).toBe(false);
  });
});

describe('availability, oversight and administration', () => {
  it('stops answering when unpublished, paused or out of the audience; the owner sees feedback, not the chat', async () => {
    await publishToAna();
    const dm = (await call(ana, 'POST', `/api/agents/${helpdesk.id}/conversation`)).json.conversation_id as string;
    expect(await conversationReplyState(db, ana.id, dm)).toBe('ok');
    expect(await publicBotFor(db, ben.id, helpdesk.id)).toBeNull();

    // Administrator pause / resume.
    expect((await call(boss, 'POST', `/api/admin/agents/${helpdesk.id}/pause`)).status).toBe(200);
    expect(await conversationReplyState(db, ana.id, dm)).toBe('agent_unavailable');
    expect((await call(boss, 'GET', '/api/admin/agents')).json.agents).toEqual([
      expect.objectContaining({
        id: helpdesk.id,
        paused: true,
        available: false,
        users: 1,
        audience: { everyone: false, user_count: 1, group_count: 0 },
      }),
    ]);
    await call(boss, 'POST', `/api/admin/agents/${helpdesk.id}/resume`);
    expect(await conversationReplyState(db, ana.id, dm)).toBe('ok');

    // Feedback on a reply: the owner sees the rating and Ana's words — nothing of the conversation.
    const reply = await db.sessions.addMessage({
      session_id: dm,
      role: 'assistant',
      content: 'Restart it.',
      bot_id: helpdesk.id,
    });
    const rated = await call(ana, 'POST', `/api/bots/conversations/${dm}/messages/${reply.id}/feedback`, {
      rating: -1,
      comment: 'Did not help',
    });
    expect(rated.status).toBe(200);
    const feedback = await call(jim, 'GET', `/api/bots/${helpdesk.id}/feedback`);
    expect(feedback.json.feedback).toEqual([
      expect.objectContaining({
        rating: -1,
        comment: 'Did not help',
        version: 1,
        user: { id: ana.id, nickname: 'Ana' },
      }),
    ]);
    expect(JSON.stringify(feedback.json)).not.toContain('Restart it.');
    expect((await call(ana, 'GET', `/api/bots/${helpdesk.id}/feedback`)).status).toBe(404);
    // Ana sees her own rating with the conversation, and can take it back.
    expect((await call(ana, 'GET', `/api/bots/conversations/${dm}`)).json.my_ratings).toEqual({ [reply.id]: -1 });
    expect((await call(ana, 'DELETE', `/api/bots/conversations/${dm}/messages/${reply.id}/feedback`)).status).toBe(200);
    expect((await call(ana, 'GET', `/api/bots/conversations/${dm}`)).json.my_ratings).toBeUndefined();
    expect((await call(jim, 'GET', `/api/bots/${helpdesk.id}/feedback`)).json.feedback).toEqual([]);

    // The owner takes it back.
    await call(jim, 'PUT', `/api/bots/${helpdesk.id}/publication`, { visibility: 'private' });
    expect(await conversationReplyState(db, ana.id, dm)).toBe('agent_unavailable');
    expect((await call(ana, 'GET', '/api/bots')).json.shared_bots).toEqual([
      expect.objectContaining({ id: helpdesk.id, available: false }),
    ]);
  });
});

describe('public knowledge authorization at execution time', () => {
  async function fixture() {
    const folder = await db.drive.createFolder({
      scope: 'kb',
      name: 'Handbook',
      visibility: 'team',
      owner_user_id: jim.id,
    });
    const child = await db.drive.createFolder({
      scope: 'kb',
      name: 'Guides',
      visibility: 'team',
      owner_user_id: jim.id,
      parent_id: folder.id,
    });
    const doc = await db.knowledgeBase.create({
      doc_id: `public-vpn-${Date.now()}`,
      title: 'VPN handbook',
      content: 'VPN synthetic restricted content',
      visibility: 'team',
      status: 'published',
      folder_id: child.id,
      owner_user_id: ben.id,
    });
    await publishToAna();
    await call(jim, 'PUT', `/api/bots/${helpdesk.id}/publication`, { grants: { kb_folder_ids: [folder.id] } });
    const knowledge = createGrantedKnowledgeTool(db, helpdesk, ana.id);
    const execute = (action: 'get' | 'list' | 'search') =>
      runInAgentScope({ botId: helpdesk.id, sessionId: 'public-test-session', requestedByUserId: ana.id }, () =>
        knowledge.execute!({ action, id: doc.id, query: 'VPN' }, {} as never),
      );
    const visible = async () => {
      expect(await execute('get')).toMatchObject({ id: doc.id, content: doc.content });
      for (const action of ['list', 'search'] as const)
        expect(await execute(action)).toMatchObject({ results: [expect.objectContaining({ id: doc.id })] });
    };
    const hidden = async () => {
      expect(await execute('get')).toHaveProperty('error');
      for (const action of ['list', 'search'] as const) expect(await execute(action)).toMatchObject({ results: [] });
    };
    return { folder, child, doc, execute, visible, hidden };
  }

  it('uses the owner’s current capability and status, with Agent/requester audit attribution', async () => {
    const f = await fixture();
    await db.platform.setUserCapabilityOverride({
      org_id: PLATFORM_ORG_ID,
      user_id: ana.id,
      capability: 'knowledge.*',
      effect: 'deny',
    });
    await f.visible(); // the requester cannot lend or remove the owner's permissions
    const events = await db.platform.listAuditEventsForAgent(PLATFORM_ORG_ID, helpdesk.id, jim.id);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor_id: `bot:${helpdesk.id}`,
          on_behalf_of_user_id: jim.id,
          requested_by_user_id: ana.id,
          action_id: 'readDocument',
          result: 'success',
        }),
      ]),
    );
    await db.platform.setUserCapabilityOverride({
      org_id: PLATFORM_ORG_ID,
      user_id: jim.id,
      capability: 'knowledge.*',
      effect: 'deny',
    });
    for (const action of ['get', 'list', 'search'] as const)
      expect(await f.execute(action)).toMatchObject({ error: expect.stringContaining('knowledge.library.read') });
    expect(await db.platform.listAuditEventsForAgent(PLATFORM_ORG_ID, helpdesk.id, jim.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action_id: 'readDocument', result: 'denied', requested_by_user_id: ana.id }),
      ]),
    );
  });

  it('rejects a disabled owner even with an already-created tool', async () => {
    const f = await fixture();
    await f.visible();
    await db.users.update(jim.id, { status: 'disabled' });
    for (const action of ['get', 'list', 'search'] as const) expect(await f.execute(action)).toHaveProperty('error');
  });

  it('rechecks document privacy and current shares inside a granted team folder', async () => {
    const f = await fixture();
    await f.visible();
    await db.knowledgeBase.update(f.doc.id, { visibility: 'private' });
    await f.hidden();
    await db.knowledgeShares.grant(f.doc.id, jim.id, 'reader', ben.id);
    await f.visible();
    expect(await f.execute('get')).not.toHaveProperty('url');
    await db.knowledgeShares.revoke(f.doc.id, jim.id);
    await f.hidden();
  });

  it('filters unreadable higher-ranked candidates before list/search limits, including ILIKE fallback', async () => {
    const f = await fixture();
    const hidden = await db.knowledgeBase.create({
      doc_id: `hidden-vpn-${Date.now()}`,
      title: 'VPN VPN VPN',
      content: 'VPN VPN VPN VPN VPN',
      visibility: 'private',
      status: 'published',
      folder_id: f.child.id,
      owner_user_id: ben.id,
    });
    const opts = { folderIds: [f.child.id], readerUserId: jim.id, limit: 1 };
    expect((await db.knowledgeBase.list(opts)).map((doc) => doc.id)).toEqual([f.doc.id]);
    expect((await db.knowledgeBase.search('VPN', opts)).map((doc) => doc.id)).toEqual([f.doc.id]);
    expect((await db.knowledgeBase.searchLike('VPN', opts, 1)).map((doc) => doc.id)).toEqual([f.doc.id]);
    await db.knowledgeShares.grant(hidden.id, jim.id, 'reader', ben.id);
    expect((await db.knowledgeBase.list(opts)).map((doc) => doc.id)).toEqual([hidden.id]);
    await db.knowledgeShares.revoke(hidden.id, jim.id);
    expect((await db.knowledgeBase.list(opts)).map((doc) => doc.id)).toEqual([f.doc.id]);
  });

  it.each(['folder move', 'grant removal', 'pause', 'audience removal', 'unpublish'] as const)(
    'rechecks %s on an already-created tool',
    async (change) => {
      const f = await fixture();
      await f.visible();
      if (change === 'folder move') await db.drive.updateFolder(f.child.id, { parent_id: null });
      if (change === 'grant removal')
        await call(jim, 'PUT', `/api/bots/${helpdesk.id}/publication`, { grants: { kb_folder_ids: [] } });
      if (change === 'pause') await call(boss, 'POST', `/api/admin/agents/${helpdesk.id}/pause`);
      if (change === 'audience removal')
        await call(jim, 'PUT', `/api/bots/${helpdesk.id}/publication`, {
          audience: { everyone: false, user_ids: [ben.id], group_ids: [] },
        });
      if (change === 'unpublish')
        await call(jim, 'PUT', `/api/bots/${helpdesk.id}/publication`, { visibility: 'private' });
      for (const action of ['get', 'list', 'search'] as const) {
        const result = await f.execute(action);
        expect(result).not.toHaveProperty('content');
        expect(JSON.stringify(result)).not.toContain('VPN');
      }
    },
  );
});
