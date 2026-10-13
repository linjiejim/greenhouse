import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentMemories, getDb, messages, runs } from '@greenhouse/db';
import { createTestApp } from '../../testing.js';
import { gate, lastUserText, scriptedModel, systemText, text, toolCall } from './model.js';

async function setup(scripts: Parameters<typeof scriptedModel>[0], env: Record<string, string> = {}) {
  const model = scriptedModel(scripts);
  const app = createTestApp(env, { languageModel: model.languageModel });
  const lin = await app.member();
  const chen = await app.member();
  const wu = await app.member();
  const helper = await app.call('POST', '/api/agents', {
    token: lin.token,
    body: { name: 'Helper', role: 'Researcher', instructions: 'Answer in haiku.' },
  });
  const agentId = helper.body.id as string;
  // What the owner told it in private stays the owner's.
  await app.call('POST', `/api/agents/${agentId}/memories`, { token: lin.token, body: { title: 'Lin owner secret' } });
  const publish = (body: Record<string, unknown>) =>
    app.call('PUT', `/api/agents/${agentId}/publication`, {
      token: lin.token,
      body: { audience: [{ type: 'member', id: chen.id }], ...body },
    });
  const open = async (token: string) =>
    app.call('POST', '/api/conversations', { token, body: { kind: 'direct', agent_id: agentId } });
  const send = (token: string, conversationId: string, content: string) =>
    app.call('POST', `/api/conversations/${conversationId}/messages`, { token, body: { content } });
  return { ...app, model, lin, chen, wu, agentId, publish, open, send };
}

const replies = async (conversationId: string) =>
  (
    await getDb()
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'assistant')))
      .orderBy(asc(messages.seq))
  ).map((row) => ({ content: row.content, status: row.status }));

describe('talking to a public Agent', () => {
  it('runs the published version for the asker, with their rights and their own memory, never its owner’s', async () => {
    const { call, services, model, lin, chen, wu, agentId, publish, open, send } = await setup([
      toolCall('memory', { action: 'remember', title: 'Chen prefers tea' }),
      text('Noted.'),
    ]);
    await publish({});
    // The owner's newer, unpublished instructions never reach the audience.
    await call('PATCH', `/api/agents/${agentId}`, { token: lin.token, body: { instructions: 'Secret draft.' } });

    const thread = await open(chen.token);
    expect(thread.status).toBe(201);
    expect(thread.body).toMatchObject({ kind: 'direct', agent_id: agentId });
    expect((await replies(thread.body.id))[0]!.content).toContain('**Helper**（Researcher）');
    // The same thread comes back.
    expect((await open(chen.token)).body.id).toBe(thread.body.id);
    // Someone it was never shared with cannot open one.
    expect((await open(wu.token)).status).toBe(404);

    const sent = await send(chen.token, thread.body.id, 'remember that I like tea');
    expect(sent.status).toBe(201);
    await services.engine.idle();
    expect((await replies(thread.body.id)).at(-1)).toEqual({ content: 'Noted.', status: 'complete' });

    const system = systemText(model.prompts[0]);
    expect(system).toContain('You are a public Agent');
    expect(system).toContain(`${lin.name} made you and shared you with colleagues; you are talking with ${chen.name}`);
    expect(system).toContain(`## Your instructions (from ${lin.name})`);
    expect(system).toContain('Answer in haiku.');
    expect(system).not.toContain('Secret draft.');
    expect(lastUserText(model.prompts[0])).not.toContain('Lin owner secret');
    // Only tools that act on the asker's own things: no instructions, hand-offs, runs, schedules or saved skills.
    expect([...model.tools[0]!].sort()).toEqual([
      'ask_user',
      'conversation_query',
      'memory',
      'read_attachment',
      'skill_query',
    ]);

    const [run] = await getDb().select().from(runs).where(eq(runs.id, sent.body.run_id));
    expect(run).toMatchObject({ ownerId: chen.id, agentId, status: 'succeeded' });
    expect(run!.input.agent_version).toBe(1);

    // Its memory of chen is chen's: chen sees and forgets it; the owner never sees it.
    const [kept] = await getDb()
      .select()
      .from(agentMemories)
      .where(and(eq(agentMemories.agentId, agentId), eq(agentMemories.title, 'Chen prefers tea')));
    expect(kept!.memberId).toBe(chen.id);
    const chensView = await call('GET', `/api/agents/${agentId}/memories`, { token: chen.token });
    expect(chensView.body.items.map((memory: { title: string }) => memory.title)).toEqual(['Chen prefers tea']);
    const linsView = await call('GET', `/api/agents/${agentId}/memories`, { token: lin.token });
    expect(linsView.body.items.map((memory: { title: string }) => memory.title)).toEqual(['Lin owner secret']);
    expect((await call('GET', `/api/agents/${agentId}/memories`, { token: wu.token })).status).toBe(404);

    // The owner never reads the conversation.
    expect((await call('GET', `/api/conversations/${thread.body.id}`, { token: lin.token })).status).toBe(404);
    expect((await call('GET', `/api/conversations/${thread.body.id}/messages`, { token: lin.token })).status).toBe(404);

    // Unpublished: the thread stays chen's to read, new messages are refused, the memories can still go.
    await call('DELETE', `/api/agents/${agentId}/publication`, { token: lin.token });
    expect((await call('GET', `/api/conversations/${thread.body.id}/messages`, { token: chen.token })).status).toBe(
      200,
    );
    expect((await send(chen.token, thread.body.id, 'still there?')).body.error.code).toBe('agent_unavailable');
    expect(
      (await call('POST', `/api/agents/${agentId}/memories`, { token: chen.token, body: { title: 'x' } })).status,
    ).toBe(404);
    expect((await call('DELETE', `/api/agents/${agentId}/memories/${kept!.id}`, { token: chen.token })).status).toBe(
      204,
    );
  });

  it('keeps to its daily cap per asker, and stops when an admin pauses it, but never for its owner', async () => {
    const hold = gate();
    const { call, services, member, lin, chen, agentId, publish, open, send } = await setup([
      { parts: text('one'), gate: hold.promise },
      text('for the owner'),
      text('two'),
    ]);
    const admin = await member('admin');
    await publish({ daily_cap: 2 });
    const thread = (await open(chen.token)).body;

    expect((await send(chen.token, thread.id, 'first')).body.queued).toBe(false);
    expect((await send(chen.token, thread.id, 'second')).body.queued).toBe(true);
    // Paused while the second waits: it is answered with why, and new messages are refused.
    await call('POST', `/api/admin/public-agents/${agentId}/pause`, { token: admin.token });
    hold.open();
    await services.engine.idle();
    expect(await replies(thread.id)).toEqual([
      expect.objectContaining({ status: 'complete' }),
      { content: 'one', status: 'complete' },
      { content: '这个 Agent 已被管理员暂停。', status: 'failed' },
    ]);
    const refused = await send(chen.token, thread.id, 'third');
    expect(refused).toMatchObject({ status: 409, body: { error: { code: 'agent_paused' } } });
    // The thread stays chen's to open; the refused turn keeps its code.
    expect((await open(chen.token)).body.id).toBe(thread.id);
    const [failed] = await getDb()
      .select()
      .from(runs)
      .where(and(eq(runs.conversationId, thread.id), eq(runs.status, 'failed')));
    expect(failed!.errorCode).toBe('agent_paused');

    // Its owner still talks to it.
    const own = (
      await call('POST', '/api/conversations', { token: lin.token, body: { kind: 'direct', agent_id: agentId } })
    ).body;
    expect((await send(lin.token, own.id, 'hello')).status).toBe(201);
    await services.engine.idle();
    expect((await replies(own.id)).at(-1)).toEqual({ content: 'for the owner', status: 'complete' });

    // Resumed: the refused turn did not count; the second reply of the day is the last one.
    await call('POST', `/api/admin/public-agents/${agentId}/resume`, { token: admin.token });
    expect((await send(chen.token, thread.id, 'fourth')).status).toBe(201);
    await services.engine.idle();
    const capped = await send(chen.token, thread.id, 'fifth');
    expect(capped).toMatchObject({ status: 429, body: { error: { code: 'daily_cap_reached' } } });
  });

  it('shows its owner how much it is used and how replies were rated, never what was said', async () => {
    const { call, services, member, lin, chen, agentId, publish, open, send } = await setup([
      text('Noted the salary.'),
    ]);
    const admin = await member('admin');
    await publish({});
    const thread = (await open(chen.token)).body;
    await send(chen.token, thread.id, 'my salary is 12345');
    await services.engine.idle();
    const reply = (
      await getDb()
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, thread.id), eq(messages.content, 'Noted the salary.')))
    )[0]!;
    await call('PUT', `/api/conversations/${thread.id}/messages/${reply.id}/feedback`, {
      token: chen.token,
      body: { rating: -1, comment: 'too short' },
    });

    const usage = await call('GET', `/api/agents/${agentId}/usage`, { token: lin.token });
    expect(usage.status).toBe(200);
    expect(usage.body).toMatchObject({
      agent_id: agentId,
      period: { name: 'month' },
      turns: { total: 1, succeeded: 1, failed: 0, canceled: 0, active: 0 },
      background_runs: { total: 0 },
      people: 1,
      ratings: {
        up: 0,
        down: 1,
        comments: [{ rating: -1, comment: 'too short', version: 1, created_at: expect.any(String) }],
      },
    });
    expect(JSON.stringify(usage.body)).not.toContain('12345');
    expect(JSON.stringify(usage.body)).not.toContain(chen.id);

    const activity = await call('GET', `/api/agents/${agentId}/activity`, { token: lin.token });
    expect(activity.body.items).toEqual([
      expect.objectContaining({ kind: 'turn', status: 'succeeded', mine: false, title: '', conversation_id: null }),
    ]);
    expect(activity.body.next_cursor).toBeNull();
    expect(JSON.stringify(activity.body)).not.toContain(thread.id);

    // Only its owner reads these.
    expect((await call('GET', `/api/agents/${agentId}/usage`, { token: chen.token })).status).toBe(404);
    expect((await call('GET', `/api/agents/${agentId}/activity`, { token: chen.token })).status).toBe(404);
    // The admin sees the month's replies and people, nothing more.
    const listed = (await call('GET', '/api/admin/public-agents', { token: admin.token })).body.items[0];
    expect(listed.month).toMatchObject({ turns: 1, people: 1 });
  });

  it('gives each member their own computer only when its publication grants one', async () => {
    const { call, services, model, chen, wu, agentId, publish, open, send } = await setup(
      [text('no computer'), text('with a computer')],
      { SANDBOX_PROVIDER: 'docker' },
    );
    await publish({ computer: false });
    const thread = (await open(chen.token)).body;
    await send(chen.token, thread.id, 'hi');
    await services.engine.idle();
    expect(model.tools[0]).not.toContain('computer');
    expect((await call('GET', `/api/agents/${agentId}/computer`, { token: chen.token })).status).toBe(403);

    await publish({ computer: true });
    await send(chen.token, thread.id, 'again');
    await services.engine.idle();
    expect(model.tools[1]).toContain('computer');
    // The browser works on chen's own copy; the vault, a member's own logins, never comes with it.
    expect(model.tools[1]).toContain('browser');
    expect(model.tools[1]).not.toContain('vault');
    // Chen's own copy, not started yet; someone it is not shared with has none.
    expect((await call('GET', `/api/agents/${agentId}/computer`, { token: chen.token })).body).toMatchObject({
      agent_id: agentId,
      state: 'stopped',
    });
    expect((await call('GET', `/api/agents/${agentId}/computer`, { token: wu.token })).status).toBe(404);
  });
});
