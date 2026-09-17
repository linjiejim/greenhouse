import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../tests/helpers/internal-user.js';
import { createOwnedSession } from '../sessions/creation.js';
import coworkerRoutes from '../routes/coworkers.js';
import sessionRoutes from '../routes/sessions.js';
import type { AppEnv } from '../app-env.js';

let db: DatabaseProvider;
beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
});
async function setup() {
  const user = await createInternalTestUser(db, { email: 'inbox-owner@test.local' });
  const other = await createInternalTestUser(db, { email: 'inbox-other@test.local' });
  const actor = { id: user.id, role: 'team' as const };
  const a = await createOwnedSession(actor, { title: 'First topic' });
  const b = await createOwnedSession(actor, { title: 'Second topic' });
  const foreign = await createOwnedSession({ id: other.id, role: 'team' }, { title: 'Private other topic' });
  const reply = (sessionId: string, content = 'A delivered answer') =>
    db.sessions.addMessage({ session_id: sessionId, role: 'assistant', content });
  return { user, other, actor, a, b, foreign, reply };
}

describe('private coworker inbox', () => {
  it('groups independent topics, preserves active-topic selection and pages all history', async () => {
    const { user, a, b, reply } = await setup();
    await reply(a.id, 'First topic context only');
    await reply(b.id, 'Second topic context only');
    const agentId = a.agent_instance_id!;
    const inbox = (await db.coworkers.listInboxes(user.id)).find((item) => item.id === agentId)!;
    expect(inbox).toMatchObject({ topic_count: 2, unread_count: 2 });
    expect((await db.sessions.getMessages(b.id)).map((m) => m.content)).toEqual(['Second topic context only']);
    await db.coworkers.rememberTopic(user.id, agentId, a.id);
    expect(await db.coworkers.savedTopic(user.id, agentId)).toEqual({ active_session_id: a.id });
    await db.coworkers.rememberTopic(user.id, agentId, null);
    expect(await db.coworkers.savedTopic(user.id, agentId)).toEqual({ active_session_id: null });
    const first = await db.coworkers.listTopics(user.id, agentId, { limit: 1 });
    const second = await db.coworkers.listTopics(user.id, agentId, { before: first[0], limit: 1 });
    expect(new Set([first[0].id, second[0].id])).toEqual(new Set([a.id, b.id]));
  });

  it('marks only observed replies, survives new reads, and leaves racing arrivals unread', async () => {
    const { user, other, a, foreign, reply } = await setup();
    const first = await reply(a.id);
    const second = await reply(a.id, 'Arrived while the first message was being read');
    const secret = await reply(foreign.id, 'Private response');
    await db.coworkers.markMessagesRead(other.id, a.id, [first.id, second.id]);
    expect((await db.coworkers.listInboxes(user.id))[0].unread_count).toBe(2);
    await db.coworkers.markMessagesRead(user.id, a.id, [first.id, secret.id]);
    await db.coworkers.markMessagesRead(user.id, a.id, [first.id]);
    const inbox = (await db.coworkers.listInboxes(user.id))[0];
    expect(inbox).toMatchObject({ unread_count: 1, first_unread_message_id: second.id, first_unread_session_id: a.id });
    expect((await db.coworkers.listInboxes(other.id))[0].unread_count).toBe(1);
    await db.coworkers.markMessagesRead(user.id, a.id, [second.id]);
    expect((await db.coworkers.listInboxes(user.id))[0].unread_count).toBe(0);
  });

  it('counts regenerated answers again and does not count internal peer messages or notification mirrors', async () => {
    const { user, a, reply } = await setup();
    const first = await reply(a.id);
    await db.coworkers.markMessagesRead(user.id, a.id, [first.id]);
    await db.sessions.replaceLatestAssistant(a.id, first.id, {
      session_id: a.id,
      role: 'assistant',
      content: 'A corrected reply',
    });
    const child = await db.sessions.create('Peer execution', a.profile_id, user.id, undefined, 'subagent', a.id, {
      agentInstanceId: a.agent_instance_id!,
    });
    await reply(child.id);
    await db.notifications.create({
      user_id: user.id,
      kind: 'runtime_completed',
      title: 'Result',
      body: 'Same result',
      dedupe_key: 'result',
    });
    expect((await db.coworkers.listInboxes(user.id))[0]).toMatchObject({ topic_count: 2, unread_count: 1 });
    expect((await db.coworkers.listTopics(user.id, a.agent_instance_id!)).some((topic) => topic.id === child.id)).toBe(
      false,
    );
  });

  it('derives work and attention from Runtime independently of read receipts and excludes other users', async () => {
    const { user, other, a, foreign, reply } = await setup();
    const run = await db.runtime.createRun({
      kind: 'mission',
      owner_user_id: user.id,
      initiated_by_user_id: user.id,
      session_id: a.id,
      source_kind: 'agent_run',
      source_id: 'inbox-mission',
      idempotency_key: 'inbox-mission',
      input: {},
    });
    const interrupt = await db.runtime.createInterrupt({
      run_id: run.id,
      kind: 'external_dependency',
      payload: { question: 'Waiting for input' },
      assignee_user_id: user.id,
    });
    await db.runtime.createRun({
      kind: 'chat',
      owner_user_id: other.id,
      initiated_by_user_id: other.id,
      session_id: foreign.id,
      source_kind: 'chat',
      source_id: 'foreign-chat',
      idempotency_key: 'foreign-chat',
      input: {},
    });
    const answer = await reply(a.id);
    await db.coworkers.markMessagesRead(user.id, a.id, [answer.id]);
    expect((await db.coworkers.listInboxes(user.id))[0]).toMatchObject({
      unread_count: 0,
      running_count: 1,
      attention_count: 1,
    });
    expect(await db.coworkers.inboxActivities(user.id, a.agent_instance_id!)).toMatchObject([
      { id: run.id, session_id: a.id, status: 'queued', attention: true },
    ]);
    expect((await db.runtime.getInterrupt(interrupt.id))?.status).toBe('pending');
    await db.runtime.commandInterrupt(
      {
        type: 'resolve',
        interrupt_id: interrupt.id,
        expected_version: interrupt.version,
        idempotency_key: 'resolve-inbox',
        decision: { approved: true },
      },
      user.id,
    );
    expect((await db.coworkers.listInboxes(user.id))[0]).toMatchObject({ running_count: 1, attention_count: 0 });
  });

  it('enforces ownership even for super readers and rejects forged active-topic associations', async () => {
    const { user, other, a, foreign, reply } = await setup();
    await reply(foreign.id, 'Do not expose');
    const app = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('user', { id: user.id, role: 'super', email: user.email, nickname: user.nickname } as never);
        await next();
      })
      .route('/api/coworkers', coworkerRoutes);
    expect((await app.request(`/api/coworkers/${foreign.agent_instance_id}/topics`)).status).toBe(404);
    const write = (path: string, body: object) =>
      app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await write(`/api/coworkers/${a.agent_instance_id}/visit`, { session_id: foreign.id })).status).toBe(404);
    expect((await write(`/api/coworkers/topics/${foreign.id}/read`, { message_ids: [] })).status).toBe(404);
    expect((await app.request(`/api/coworkers/${a.agent_instance_id}/topics?cursor=bad`)).status).toBe(400);
    const own = await (await app.request('/api/coworkers')).json();
    expect(own.inboxes.some((item: { id: string }) => item.id === foreign.agent_instance_id)).toBe(false);
    expect(await db.coworkers.savedTopic(other.id, foreign.agent_instance_id!)).toBeUndefined();
  });

  it('does not backfill another coworker or another user into a filtered private sidebar', async () => {
    const { user, a, foreign } = await setup();
    const agent = await db.coworkers.ensure({
      owner_user_id: user.id,
      profile_key: 'custom:9999',
      name: 'Other colleague',
    });
    const otherTopic = await db.sessions.create(
      'Other coworker',
      'custom:9999@1',
      user.id,
      undefined,
      'web',
      undefined,
      { agentInstanceId: agent.id },
    );
    await db.sessionGroups.pin(user.id, otherTopic.id);
    await db.sessionGroups.pin(user.id, foreign.id);
    const app = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('user', { id: user.id, role: 'super', email: user.email, nickname: user.nickname } as never);
        await next();
      })
      .route('/api/sessions', sessionRoutes);
    const response = await app.request('/api/sessions?scope=mine&profile_key=sprouty&status=active');
    expect(response.status).toBe(200);
    const body = await response.json();
    const rows = body.sessions ?? body;
    expect(rows.some((s: { id: string }) => s.id === a.id)).toBe(true);
    expect(rows.some((s: { id: string }) => s.id === otherTopic.id || s.id === foreign.id)).toBe(false);
  });
});
