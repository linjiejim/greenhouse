import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { RealtimeEvent } from '@greenhouse/contract';
import {
  agentMemories,
  conversationInbox,
  getDb,
  messageReceipts,
  messages,
  newId,
  runs,
  runSteps,
} from '@greenhouse/db';
import { ApiError } from '../../http/errors.js';
import { createTestApp } from '../../testing.js';
import { gate, lastUserText, scriptedModel, systemText, text, toolCall } from './model.js';

async function setup(scripts: Parameters<typeof scriptedModel>[0], options?: Parameters<typeof scriptedModel>[1]) {
  const model = scriptedModel(scripts, options);
  const app = createTestApp({}, { languageModel: model.languageModel });
  const lin = await app.member();
  const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
  return { ...app, model, lin, main };
}

describe('the engine', () => {
  it('answers a message in the main thread and keeps the whole exchange', async () => {
    const { call, services, model, lin, main } = await setup([text('Hello Lin, how can I help?')]);
    expect(main).toMatchObject({ kind: 'main', last_seq: 1 });

    const events: RealtimeEvent[] = [];
    services.hub.subscribe(lin.id, (event) => events.push(event));
    const sent = await call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'Hi' },
    });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ queued: false, message: { role: 'user', content: 'Hi', seq: 2 } });
    await services.engine.idle();

    const page = await call('GET', `/api/conversations/${main.id}/messages`, { token: lin.token });
    expect(page.body.items.map((m: { role: string; status: string }) => [m.role, m.status])).toEqual([
      ['assistant', 'complete'],
      ['user', 'complete'],
      ['assistant', 'complete'],
    ]);
    expect(page.body.items[0].content).toContain('Greeny');
    expect(page.body.items[2]).toMatchObject({ content: 'Hello Lin, how can I help?', run_id: sent.body.run_id });

    const [run] = await getDb().select().from(runs).where(eq(runs.id, sent.body.run_id));
    expect(run).toMatchObject({ kind: 'turn', status: 'succeeded', ownerId: lin.id, leaseOwner: null });
    const [receipt] = await getDb()
      .select()
      .from(messageReceipts)
      .where(eq(messageReceipts.messageId, sent.body.message.id));
    expect(receipt!.status).toBe('answered');

    // The prompt: who the Agent is, and this turn's task at the end.
    expect(systemText(model.prompts[0])).toContain('You are **Greeny**');
    expect(lastUserText(model.prompts[0])).toContain('Reply to');

    const types = events.map((event) => event.type);
    expect(types).toContain('message.delta');
    expect(types.at(-1)).toBe('conversation.updated');
    const deltas = events
      .filter((event) => event.type === 'message.delta')
      .map((event) => (event.data as { text: string }).text);
    expect(deltas.join('')).toBe('Hello Lin, how can I help?');
  });

  it('queues messages sent while it answers, then answers them together', async () => {
    const hold = gate();
    const { call, services, model, lin, main } = await setup([
      { parts: text('First answer.'), gate: hold.promise },
      text('Answer to both.'),
    ]);
    const first = await call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'one' },
    });
    const second = await call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'two' },
    });
    const third = await call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'three' },
    });
    expect(first.body.queued).toBe(false);
    expect(second.body).toMatchObject({ queued: true, run_id: null });
    expect(third.body.queued).toBe(true);
    expect((await call('GET', `/api/conversations/${main.id}`, { token: lin.token })).body.working).toBe(true);

    hold.open();
    await services.engine.idle();
    expect(model.calls()).toBe(2);
    expect(lastUserText(model.prompts[1])).toContain('sent 2 messages');
    const all = await getDb()
      .select()
      .from(messages)
      .where(eq(messages.conversationId, main.id))
      .orderBy(asc(messages.seq));
    expect(all.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual([
      expect.stringContaining('Greeny'),
      'First answer.',
      'Answer to both.',
    ]);
    const pending = await getDb().select().from(conversationInbox).where(eq(conversationInbox.conversationId, main.id));
    expect(pending.every((item) => item.consumedAt)).toBe(true);
    expect((await call('GET', `/api/conversations/${main.id}`, { token: lin.token })).body.working).toBe(false);
  });

  it('stops at once, keeps what was written, and drops the queue', async () => {
    const hold = gate();
    const { call, services, lin, main } = await setup([{ parts: text('never finished'), gate: hold.promise }]);
    const sent = await call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'go' },
    });
    const queued = await call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'and this' },
    });
    expect((await call('POST', `/api/conversations/${main.id}/stop`, { token: lin.token })).status).toBe(202);
    await services.engine.idle();
    const [run] = await getDb().select().from(runs).where(eq(runs.id, sent.body.run_id));
    expect(run).toMatchObject({ status: 'canceled', desiredState: 'cancel' });
    const [reply] = await getDb().select().from(messages).where(eq(messages.runId, sent.body.run_id));
    expect(reply!.status).toBe('stopped');
    const [receipt] = await getDb()
      .select()
      .from(messageReceipts)
      .where(eq(messageReceipts.messageId, queued.body.message.id));
    expect(receipt!.status).toBe('canceled');
    // Nothing answers the dropped message.
    expect((await getDb().select().from(runs).where(eq(runs.conversationId, main.id))).length).toBe(1);
  });

  it('recovers a turn whose process died and carries on with its queue', async () => {
    const { call, services, lin, main } = await setup([text('Back again.')]);
    const agent = (await call('GET', '/api/agents/main', { token: lin.token })).body;
    const runId = newId('run');
    await getDb()
      .insert(runs)
      .values({
        id: runId,
        agentId: agent.id,
        ownerId: lin.id,
        kind: 'turn',
        source: 'conversation',
        conversationId: main.id,
        status: 'running',
        leaseOwner: 'api-dead',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
        input: { reason: 'message', message_ids: [] },
      });
    const half = await services.conversations.append(main.id, {
      role: 'assistant',
      agentId: agent.id,
      runId,
      status: 'streaming',
      content: 'Half of an ans',
    });
    // A message that arrived while the dead turn held the conversation.
    const waiting = await call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'hello?' },
    });
    expect(waiting.body.queued).toBe(true);

    await services.engine.sweep();
    await services.engine.idle();
    const [dead] = await getDb().select().from(runs).where(eq(runs.id, runId));
    expect(dead).toMatchObject({ status: 'failed', errorCode: 'interrupted' });
    const [kept] = await getDb().select().from(messages).where(eq(messages.id, half.id));
    expect(kept).toMatchObject({ status: 'failed', content: 'Half of an ans' });
    const replies = await getDb()
      .select()
      .from(messages)
      .where(
        and(eq(messages.conversationId, main.id), eq(messages.role, 'assistant'), eq(messages.status, 'complete')),
      );
    expect(replies.map((m) => m.content)).toContain('Back again.');
  });

  it('answers plainly when no model service is configured', async () => {
    const app = createTestApp(
      {},
      {
        languageModel: async () => {
          throw new ApiError(503, 'llm_not_configured', 'No model service is configured yet.');
        },
      },
    );
    const lin = await app.member();
    const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
    const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'hi' },
    });
    await app.services.engine.idle();
    const [reply] = await getDb().select().from(messages).where(eq(messages.runId, sent.body.run_id));
    expect(reply).toMatchObject({ status: 'failed', content: expect.stringContaining('管理 → 服务') });
    const [run] = await getDb().select().from(runs).where(eq(runs.id, sent.body.run_id));
    expect(run).toMatchObject({ status: 'failed', errorCode: 'llm_not_configured' });
  });

  it('lets the Agent remember, records the step, and shows the memory next turn', async () => {
    const { call, services, model, lin, main } = await setup([
      toolCall('memory', { action: 'remember', title: 'Lin prefers tea', category: 'preference' }),
      text('Noted.'),
      text('You like tea.'),
    ]);
    const sent = await call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'I prefer tea' },
    });
    await services.engine.idle();
    const memories = await getDb().select().from(agentMemories).where(eq(agentMemories.memberId, lin.id));
    expect(memories).toEqual([
      expect.objectContaining({ title: 'Lin prefers tea', source: 'agent', sourceConversationId: main.id }),
    ]);
    const [step] = await getDb().select().from(runSteps).where(eq(runSteps.runId, sent.body.run_id));
    expect(step).toMatchObject({ toolName: 'memory', status: 'succeeded', kind: 'tool' });
    const [reply] = await getDb().select().from(messages).where(eq(messages.runId, sent.body.run_id));
    expect(reply!.steps).toEqual([
      expect.objectContaining({ tool: 'memory', status: 'done', summary: '记住了一件事' }),
    ]);

    await call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'what do I like?' },
    });
    await services.engine.idle();
    expect(lastUserText(model.prompts[2])).toContain('Lin prefers tea');
  });

  it('names a new chat after its first exchange', async () => {
    const { call, services, lin } = await setup([text('Sure.')], { title: 'Trip to Kyoto' });
    const chat = await call('POST', '/api/conversations', { token: lin.token, body: { kind: 'chat' } });
    expect(chat.body).toMatchObject({ kind: 'chat', title: '', last_seq: 0 });
    await call('POST', `/api/conversations/${chat.body.id}/messages`, {
      token: lin.token,
      body: { content: 'Plan a trip' },
    });
    await services.engine.idle();
    expect((await call('GET', `/api/conversations/${chat.body.id}`, { token: lin.token })).body.title).toBe(
      'Trip to Kyoto',
    );
  });

  it('in a room, an Agent answers only when its owner names it', async () => {
    const { call, services, member, lin } = await setup([text('At your service.')]);
    const chen = await member();
    const room = await call('POST', '/api/conversations', {
      token: lin.token,
      body: { kind: 'room', title: 'Launch', member_ids: [chen.id], agent_ids: ['main'] },
    });
    expect(room.status).toBe(201);
    const silent = await call('POST', `/api/conversations/${room.body.id}/messages`, {
      token: chen.token,
      body: { content: 'hello all' },
    });
    expect(silent.body.run_id).toBeNull();
    const byOther = await call('POST', `/api/conversations/${room.body.id}/messages`, {
      token: chen.token,
      body: { content: '@Greeny help', mentions: [room.body.agent_ids[0]] },
    });
    expect(byOther.body.run_id).toBeNull();
    const asked = await call('POST', `/api/conversations/${room.body.id}/messages`, {
      token: lin.token,
      body: { content: '@Greeny help', mentions: ['main'] },
    });
    expect(asked.body.run_id).toBeTruthy();
    await services.engine.idle();
    const chenView = await call('GET', `/api/conversations/${room.body.id}/messages`, { token: chen.token });
    expect(chenView.body.items.at(-1)).toMatchObject({ role: 'assistant', content: 'At your service.' });
    expect((await call('POST', `/api/conversations/${room.body.id}/stop`, { token: chen.token })).status).toBe(202);
  });
});
