import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import sessions from '../../routes/sessions.js';
import runtime from '../../routes/runtime.js';
import shares from '../../routes/shares.js';
import evalRoutes from '../../routes/eval.js';
import { createSessionQueryTool } from '../../tools/session-query.js';
import { createEvalMessageTool } from '../../tools/eval-message.js';
import { startChatRuntimeTrace, settleChatRuntimeTrace } from '../../chat/runtime.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { admitBotTask } from '../engine/tasks.js';

let db: DatabaseProvider;
let owner: UserRow;
let superUser: UserRow;

function app(user: UserRow) {
  return new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('user', { id: user.id, role: user.role });
      await next();
    })
    .route('/sessions', sessions)
    .route('/runtime', runtime)
    .route('/shares', shares)
    .route('/eval', evalRoutes);
}

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  owner = await createInternalTestUser(db, { email: `owner-${randomUUID()}@test.local`, role: 'super' });
  superUser = await createInternalTestUser(db, { email: `super-${randomUUID()}@test.local`, role: 'super' });
});

describe('Bots privacy across generic read models', () => {
  it('keeps foreground Runtime evidence owner-only, including after session deletion', async () => {
    const session = await db.sessions.create('Private Bot', 'sprouty', owner.id, undefined, 'bots');
    const trace = await startChatRuntimeTrace(db, {
      ownerUserId: owner.id,
      sessionId: session.id,
      sourceId: `bots:${randomUUID()}:0`,
      input: { source_mode: 'bots', private_text: 'private-test-marker' },
    });
    await settleChatRuntimeTrace(db, trace, { status: 'succeeded', output: { text: 'private-test-marker' } });
    const paths = [
      `/runtime/runs/${trace.runId}`,
      `/runtime/runs/${trace.runId}/events`,
      `/eval/datasets/from-runtime/${trace.runId}/preview`,
    ];
    for (const path of paths) {
      expect((await app(owner).request(path)).status, `owner: ${path}`).toBe(200);
      expect((await app(superUser).request(path)).status, `other super: ${path}`).toBe(404);
    }
    const response = await app(superUser).request('/runtime/runs?scope=all&kinds=chat');
    expect(await response.text()).not.toContain(trace.runId);
    await db.sessions.delete(session.id);
    for (const path of paths) expect((await app(superUser).request(path)).status, path).toBe(404);
  });

  it('protects task transcripts, explicit lists, shares, tools and Runtime while preserving ordinary subagents', async () => {
    const bot = await db.bots.createBot({ user_id: owner.id, name: 'Private Bot' });
    const parent = (await db.bots.ensureDirectConversation(owner.id, bot.id)).session_id;
    const task = await admitBotTask({
      db,
      userId: owner.id,
      bot,
      conversationId: parent,
      title: 'Private research',
      brief: 'Approved brief',
      requestId: randomUUID(),
    });
    const normal = await db.sessions.create('Ordinary child', 'team', owner.id, undefined, 'subagent');
    for (const id of [task.childSessionId, normal.id]) {
      await db.sessions.addMessage({ session_id: id, role: 'assistant', content: 'synthetic private result' });
    }
    expect((await app(superUser).request(`/sessions/${normal.id}/messages`)).status).toBe(200);
    expect((await app(owner).request(`/sessions/${task.childSessionId}/messages`)).status).toBe(200);
    expect((await app(superUser).request(`/sessions/${task.childSessionId}/messages`)).status).toBe(404);
    expect((await app(superUser).request(`/sessions/${task.childSessionId}`, { method: 'DELETE' })).status).toBe(403);
    for (const suffix of ['', '&scope=team', '&scope=shared']) {
      const response = await app(superUser).request(`/sessions?channel=subagent${suffix}`);
      expect(await response.text()).not.toContain(task.childSessionId);
    }
    const query = createSessionQueryTool(db, { userId: superUser.id, userRole: 'super' });
    for (const action of ['get', 'messages', 'usage'] as const) {
      expect(await query.execute!({ action, session_id: task.childSessionId }, {} as never)).toMatchObject({
        error: expect.stringContaining('Access denied'),
      });
    }
    expect(JSON.stringify(await query.execute!({ action: 'list', channel: 'subagent' }, {} as never))).not.toContain(
      task.childSessionId,
    );
    const evaluator = createEvalMessageTool(db, { userId: superUser.id, userRole: 'super' });
    expect(
      await evaluator.execute!({ session_id: task.childSessionId, message_id: randomUUID() }, {} as never),
    ).toMatchObject({ error: 'Session not found or unavailable', steps: [] });
    for (const actor of [owner, superUser]) {
      const share = await app(actor).request('/shares', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: task.childSessionId, user_ids: [superUser.id] }),
      });
      expect(share.status).toBe(400);
    }
    // Old shares must not restore access or leak the private title in the inbox.
    await db.sessionShares.createMany([
      { session_id: task.childSessionId, shared_with: superUser.id, shared_by: owner.id },
    ]);
    expect(await (await app(superUser).request('/shares')).text()).not.toContain(task.childSessionId);
    expect(await db.sessionShares.getSharedSessionIds(superUser.id)).not.toContain(task.childSessionId);
    expect((await app(superUser).request(`/runtime/runs/${task.runId}`)).status).toBe(404);
    expect((await app(owner).request(`/runtime/runs/${task.runId}`)).status).toBe(200);
    expect(await (await app(superUser).request('/runtime/runs?scope=all&kinds=subagent')).text()).not.toContain(
      task.runId,
    );
    expect(
      (
        await app(superUser).request(`/runtime/runs/${task.runId}/commands`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'cancel', expected_version: 1, idempotency_key: randomUUID() }),
        })
      ).status,
    ).toBe(404);
  });

  it('filters private runs and interrupts before pagination and summary counts', async () => {
    const client = app(superUser);
    const summaryPath = '/runtime/summary?scope=all&kinds=chat';
    const baseline = await (await client.request(summaryPath)).json();
    const privateRun = await db.runtime.createRun({
      kind: 'chat',
      owner_user_id: owner.id,
      initiated_by_user_id: owner.id,
      source_kind: 'chat_turn',
      source_id: randomUUID(),
      idempotency_key: randomUUID(),
      // The marker still protects a trace with no surviving session/source prefix.
      input: { source_mode: 'bots', private: 'synthetic-marker' },
    });
    const interrupt = await db.runtime.createInterrupt({
      run_id: privateRun.id,
      kind: 'mutation_approval',
      payload: { private: 'synthetic-marker' },
      assignee_user_id: owner.id,
    });
    expect(await (await client.request(summaryPath)).json()).toEqual(baseline);
    expect(await (await client.request('/runtime/interrupts?scope=all&kinds=chat')).text()).not.toContain(interrupt.id);
    expect(
      (
        await client.request(`/runtime/interrupts/${interrupt.id}/commands`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(404);
    const normal = await db.runtime.createRun({
      kind: 'chat',
      owner_user_id: owner.id,
      initiated_by_user_id: owner.id,
      source_kind: 'chat_turn',
      source_id: randomUUID(),
      idempotency_key: randomUUID(),
      input: {},
    });
    const listed = await (await client.request('/runtime/runs?scope=all&kinds=chat&limit=1')).json();
    expect(listed.runs.map((run: { id: string }) => run.id)).toEqual([normal.id]);
    expect((await client.request(`/runtime/runs/${normal.id}`)).status).toBe(200);
  });
});
