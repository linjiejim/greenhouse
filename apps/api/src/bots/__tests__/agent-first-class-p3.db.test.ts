/**
 * Personal Agents first-class (spec 20261011-agent-first-class P3b–P3e) against real PostgreSQL:
 * a platform action an Agent takes is audited as that Agent, in that conversation, for its
 * member; usage names the Agent; a vault entry limited to some Agents is invisible to the
 * others; an Agent's usage and activity read back per Agent (owner only); and a project task
 * handed to an Agent opens a task chat that starts with the task, while the assignee stays.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type BotRow, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { runInAgentScope } from '../../platform/agent-scope.js';
import { delegatedAgentActor } from '../../platform/actor.js';
import { projectsRegistration } from '../../platform/projects/application.js';
import { initializePlatformRuntime, PLATFORM_ORG_ID, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { dispatchProjectAgentAction } from '../../platform/projects/agent-adapter.js';
import projectsRoutes from '../../routes/projects.js';
import { createBotsRoutes } from '../routes.js';
import { listVaultItems, vaultItemAllowsBot } from '../vault/service.js';

const delivered = vi.hoisted(() => [] as Array<[string, Record<string, unknown>]>);
vi.mock('../../ws/connection-manager.js', () => ({ connectionManager: { sendToUser: vi.fn() } }));
vi.mock('../engine/inbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine/inbox.js')>()),
  deliverToConversation: vi.fn(async (sessionId: string, item: Record<string, unknown>) => {
    delivered.push([sessionId, item]);
  }),
}));
vi.mock('../../auth/features.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth/features.js')>()),
  userHasFeature: async () => true,
}));

let db: DatabaseProvider;
let jim: UserRow;
let ana: UserRow;
let quill: BotRow;
let sage: BotRow;

function app() {
  const users = new Map([jim, ana].map((u) => [u.id, u]));
  const hono = new Hono<AppEnv>();
  hono.use('*', async (c, next) => {
    const user = users.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  hono.route('/api/bots', createBotsRoutes());
  hono.route('/api/projects', projectsRoutes);
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
  initializePlatformRuntime(db, [projectsRegistration]);
  const stamp = `${Date.now()}-${Math.random()}`;
  jim = await createInternalTestUser(db, { email: `p3-jim-${stamp}@test.local`, nickname: 'Jim', role: 'team' });
  ana = await createInternalTestUser(db, { email: `p3-ana-${stamp}@test.local`, nickname: 'Ana', role: 'team' });
  quill = await db.bots.createBot({ user_id: jim.id, name: 'Quill', role: 'Writer' });
  sage = await db.bots.createBot({ user_id: jim.id, name: 'Sage', role: 'Researcher' });
  delivered.length = 0;
});

afterEach(() => {
  resetPlatformRuntimeForTests();
});

describe('who acted (P3b)', () => {
  it('names the Agent, its member and the conversation on the actor and the audit row', async () => {
    expect(delegatedAgentActor({ userId: jim.id })).toMatchObject({ actorId: `agent:${jim.id}` });
    const actor = runInAgentScope({ botId: quill.id, sessionId: 'sess-1' }, () =>
      delegatedAgentActor({ userId: jim.id }),
    );
    expect(actor).toMatchObject({
      actorId: `bot:${quill.id}`,
      actorType: 'agent',
      onBehalfOfUserId: jim.id,
      agentId: quill.id,
      sessionId: 'sess-1',
    });
    // An external client stays the actor even inside a scope.
    expect(
      runInAgentScope({ botId: quill.id, sessionId: null }, () =>
        delegatedAgentActor({ userId: jim.id, clientId: 'mcp-client' }),
      ),
    ).toMatchObject({ actorId: 'mcp-client', onBehalfOfUserId: jim.id });

    const created = await runInAgentScope({ botId: quill.id, sessionId: 'sess-1' }, () =>
      dispatchProjectAgentAction({ userId: jim.id }, 'createProject', { title: 'Launch notes' }),
    );
    expect(created.ok).toBe(true);
    const [event] = await db.platform.listAuditEventsForAgent(PLATFORM_ORG_ID, quill.id, jim.id);
    expect(event).toMatchObject({
      actor_id: `bot:${quill.id}`,
      agent_id: quill.id,
      on_behalf_of_user_id: jim.id,
      session_id: 'sess-1',
      action_id: 'createProject',
      result: 'success',
    });
    expect(await db.platform.listAuditEventsForAgent(PLATFORM_ORG_ID, sage.id, jim.id)).toEqual([]);
  });

  it('reports an Agent’s usage per day and what it did — to its member only', async () => {
    await db.usage.record({
      profile_id: `bot:${quill.id}`,
      caller: 'bots-turn',
      session_id: 'sess-1',
      user_id: jim.id,
      bot_id: quill.id,
      model: 'flash',
      input_tokens: 1200,
      output_tokens: 300,
    });
    await db.usage.record({
      profile_id: 'sprouty',
      caller: 'bots-turn',
      user_id: jim.id,
      bot_id: sage.id,
      model: 'flash',
      input_tokens: 5,
      output_tokens: 5,
    });
    await runInAgentScope({ botId: quill.id, sessionId: 'sess-2' }, () =>
      dispatchProjectAgentAction({ userId: jim.id }, 'createProject', { title: 'Q4 plan' }),
    );

    const usage = await call(jim, 'GET', `/api/bots/${quill.id}/usage`);
    expect(usage.status).toBe(200);
    expect(usage.json.totals).toEqual({ calls: 1, input_tokens: 1200, output_tokens: 300 });
    expect(usage.json.days).toEqual([expect.objectContaining({ calls: 1, sessions: 1 })]);

    const activity = await call(jim, 'GET', `/api/bots/${quill.id}/activity`);
    expect(activity.json.activity).toEqual([
      expect.objectContaining({
        kind: 'action',
        title: 'projects.createProject',
        outcome: 'success',
        session_id: 'sess-2',
      }),
    ]);

    expect((await call(ana, 'GET', `/api/bots/${quill.id}/usage`)).status).toBe(404);
    expect((await call(ana, 'GET', `/api/bots/${quill.id}/activity`)).status).toBe(404);
  });
});

describe('vault entries per Agent (P3c)', () => {
  it('limits an entry to the Agents chosen; every Agent sees an unlimited one', async () => {
    await db.vault.create({
      id: `vlt_all_${Date.now()}`,
      user_id: jim.id,
      label: 'Mail',
      origins: ['https://mail.example.com'],
      username_enc: null,
      username_hint: '',
      password_enc: null,
      totp_enc: null,
      policy: 'ask',
    });
    const limited = await db.vault.create({
      id: `vlt_quill_${Date.now()}`,
      user_id: jim.id,
      label: 'CMS',
      origins: ['https://cms.example.com'],
      username_enc: null,
      username_hint: '',
      password_enc: null,
      totp_enc: null,
      policy: 'ask',
      bot_ids: [quill.id],
    });
    expect(vaultItemAllowsBot(limited, quill.id)).toBe(true);
    expect(vaultItemAllowsBot(limited, sage.id)).toBe(false);
    expect((await listVaultItems(db, jim.id, quill.id)).map((item) => item.label).sort()).toEqual(['CMS', 'Mail']);
    expect((await listVaultItems(db, jim.id, sage.id)).map((item) => item.label)).toEqual(['Mail']);
    // The member's own screens see every entry, with whom it is limited to.
    const all = await listVaultItems(db, jim.id);
    expect(all.find((item) => item.label === 'CMS')?.bot_ids).toEqual([quill.id]);
    expect(all.find((item) => item.label === 'Mail')?.bot_ids).toBeNull();
  });
});

describe('a project task handed to an Agent (P3e)', () => {
  it('opens a task chat that starts with the task, records it on the task, and keeps the assignee', async () => {
    const project = await db.projects.createProject({ title: 'Website', owner_id: jim.id, created_by: jim.id });
    const task = await db.projects.createTask({
      project_id: project.id,
      title: 'Rewrite the pricing page',
      description: 'Shorter, with the new tiers.',
      assignee_id: jim.id,
      created_by: jim.id,
    });

    const handed = await call(jim, 'POST', `/api/projects/tasks/${task.id}/agent`, { bot_id: quill.id });
    expect(handed.status).toBe(201);
    const sessionId = handed.json.session_id as string;
    expect(handed.json.task).toMatchObject({ agent_id: quill.id, agent_session_id: sessionId, assignee_id: jim.id });

    const chat = await db.bots.getConversation(jim.id, sessionId);
    expect(chat).toMatchObject({ kind: 'task', owner_bot_id: quill.id, title: 'Rewrite the pricing page' });
    expect(delivered).toEqual([
      [
        sessionId,
        expect.objectContaining({ kind: 'user_message', content: expect.stringContaining('Rewrite the pricing page') }),
      ],
    ]);
    expect(String(delivered[0]![1].content)).toContain('Shorter, with the new tiers.');
    const activities = await db.projects.getActivities(project.id);
    expect(activities[0]).toMatchObject({ action: 'task_handed_to_agent', detail: 'Quill', task_id: task.id });

    // Someone else's Agent, or a task they cannot write: nothing opens.
    const anaBot = await db.bots.createBot({ user_id: ana.id, name: 'Ivy', role: '' });
    expect((await call(jim, 'POST', `/api/projects/tasks/${task.id}/agent`, { bot_id: anaBot.id })).status).toBe(404);
    const refused = await call(ana, 'POST', `/api/projects/tasks/${task.id}/agent`, { bot_id: anaBot.id });
    expect(refused.status).toBe(404);
    expect(await db.bots.listConversations(ana.id, 100, { kinds: ['task'] })).toEqual([]);
  });
});
