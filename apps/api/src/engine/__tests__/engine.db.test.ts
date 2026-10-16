import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
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
import { logger } from '@greenhouse/utils/logger';
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
  it('keeps the tools and the system prompt byte for byte between turns, and marks where the cache ends', async () => {
    const { call, services, model, lin, main } = await setup([text('One.'), text('Two.')]);
    await call('POST', `/api/conversations/${main.id}/messages`, { token: lin.token, body: { content: 'Plain' } });
    await services.engine.idle();
    // Between the two turns the screen changes what it draws, and the Agent learns something.
    await call('POST', `/api/agents/main/memories`, {
      token: lin.token,
      body: { title: 'Likes short answers', content: '' },
    });
    await call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'Rich', rich_blocks: ['stats', 'not-a-block'] },
    });
    await services.engine.idle();
    expect(model.toolsJson[1]).toBe(model.toolsJson[0]);
    expect(systemText(model.prompts[1])).toBe(systemText(model.prompts[0]));
    // Every block is taught in the system prompt; the closing message names what this screen draws.
    expect(systemText(model.prompts[0])).toContain('### 图表（chart）');
    expect(systemText(model.prompts[0])).toContain('### 指标卡（stats）');
    expect(lastUserText(model.prompts[0])).toContain(
      '## Rich blocks this screen draws\nchart, datatable, confirm, mermaid, html-preview',
    );
    expect(lastUserText(model.prompts[1])).toContain('## Rich blocks this screen draws\nstats\n');
    // The breakpoints: the system prompt, the transcript the next turn keeps, the newest message.
    const marks = (prompt: unknown) =>
      (prompt as Array<{ role: string; providerOptions?: { greenhouse?: { cacheBreakpoint?: boolean } } }>).map(
        (message) => [message.role, message.providerOptions?.greenhouse?.cacheBreakpoint === true],
      );
    expect(marks(model.prompts[0])).toEqual([
      ['system', true],
      ['assistant', true],
      ['user', true],
    ]);
    expect(marks(model.prompts[1])).toEqual([
      ['system', true],
      ['assistant', false],
      ['user', false],
      ['assistant', true],
      ['user', true],
    ]);
  });

  it('warns in development when a later turn of a conversation reads nothing from the prompt cache', async () => {
    const uncached = (value: string) =>
      text(value).map((part) =>
        part.type === 'finish'
          ? {
              ...part,
              usage: {
                inputTokens: { total: 6000, noCache: 6000, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 5, text: 5, reasoning: 0 },
              },
            }
          : part,
      );
    const model = scriptedModel([uncached('One.'), uncached('Two.')]);
    const app = createTestApp({ NODE_ENV: 'development' }, { languageModel: model.languageModel });
    const lin = await app.member();
    const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
    const warn = vi.spyOn(logger, 'warn');
    const warned = () =>
      warn.mock.calls.filter(([message]) => String(message).includes('read nothing from the prompt cache')).length;
    try {
      for (const content of ['one', 'two']) {
        await app.call('POST', `/api/conversations/${main.id}/messages`, { token: lin.token, body: { content } });
        await app.services.engine.idle();
      }
      expect(warned()).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('looks up who sees the conversation a fixed number of times per turn, and sends a reply in frames', async () => {
    const long = Array.from({ length: 400 }, (_, index) => `word${index} `).join('');
    const { call, services, lin, main } = await setup([text('Hi.'), text(long)]);
    const events: RealtimeEvent[] = [];
    services.hub.subscribe(lin.id, (event) => events.push(event));
    const audience = vi.spyOn(services.conversations, 'audience');
    const say = async (content: string) => {
      audience.mockClear();
      await call('POST', `/api/conversations/${main.id}/messages`, { token: lin.token, body: { content } });
      await services.engine.idle();
      return audience.mock.calls.length;
    };
    const short = await say('one');
    events.length = 0;
    expect(await say('two')).toBe(short);
    expect(short).toBeGreaterThan(0);
    expect(short).toBeLessThanOrEqual(3);
    // 400 deltas went out as a handful of frames that still join into the reply.
    const deltas = events.filter(
      (event): event is Extract<RealtimeEvent, { type: 'message.delta' }> => event.type === 'message.delta',
    );
    expect(deltas.length).toBeLessThan(20);
    expect(deltas.map((delta) => delta.data.text).join('')).toBe(long);
    expect(events.at(-1)!.type).toBe('conversation.updated');
    const final = events.findIndex((event) => event.type === 'message.updated');
    expect(events.slice(final).some((event) => event.type === 'message.delta')).toBe(false);
  });

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
    const [reply] = await getDb()
      .select()
      .from(messages)
      .where(and(eq(messages.runId, sent.body.run_id), eq(messages.role, 'assistant')));
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
    const [reply] = await getDb()
      .select()
      .from(messages)
      .where(and(eq(messages.runId, sent.body.run_id), eq(messages.role, 'assistant')));
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
    const [step] = await getDb()
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, sent.body.run_id), eq(runSteps.kind, 'tool')));
    expect(step).toMatchObject({ toolName: 'memory', status: 'succeeded', kind: 'tool' });
    const [reply] = await getDb()
      .select()
      .from(messages)
      .where(and(eq(messages.runId, sent.body.run_id), eq(messages.role, 'assistant')));
    expect(reply!.steps).toEqual([
      expect.objectContaining({ tool: 'memory', status: 'done', summary: '记住了：Lin prefers tea' }),
    ]);

    const receipts = await getDb()
      .select()
      .from(messages)
      .where(and(eq(messages.runId, sent.body.run_id), eq(messages.role, 'event')));
    expect(receipts.find((message) => message.event?.type === 'write_receipt')?.content).toBe(
      '记住了：Lin prefers tea',
    );

    await call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'what do I like?' },
    });
    await services.engine.idle();
    expect(lastUserText(model.prompts[2])).toContain('Lin prefers tea');
  });

  it('names a new chat for the first member request without using the reply', async () => {
    const { call, services, lin, model } = await setup([text('Sure.')], { title: 'Trip to Kyoto' });
    const title = vi.spyOn((await model.languageModel()).model, 'doGenerate');
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
    expect(title).toHaveBeenCalledOnce();
    const prompt = title.mock.calls[0]![0].prompt;
    expect(systemText(prompt)).toContain('what the member asked for');
    expect(lastUserText(prompt)).toContain('Plan a trip');
    expect(lastUserText(prompt)).not.toContain('Sure.');
  });

  it('keeps failed intermediate wording and later follow-ups out of an untitled chat title', async () => {
    const request = '打开 example.com 并发送屏幕截图';
    const refusal = '无法提供真实屏幕截图';
    const followUp = '再试一次';
    const reply = '截图已附在回复中';
    const { call, services, lin, model } = await setup([text(reply)], { title: '打开网页并截图' });
    const title = vi.spyOn((await model.languageModel()).model, 'doGenerate');
    const chat = await call('POST', '/api/conversations', { token: lin.token, body: { kind: 'chat' } });
    await services.conversations.append(chat.body.id, {
      role: 'user',
      authorMemberId: lin.id,
      content: request,
    });
    await services.conversations.append(chat.body.id, {
      role: 'assistant',
      agentId: chat.body.agent_id,
      content: refusal,
      status: 'failed',
    });
    await call('POST', `/api/conversations/${chat.body.id}/messages`, {
      token: lin.token,
      body: { content: followUp },
    });
    await services.engine.idle();
    const prompt = lastUserText(title.mock.calls[0]![0].prompt);
    expect(prompt).toContain(request);
    for (const excluded of [refusal, followUp, reply]) expect(prompt).not.toContain(excluded);
    expect((await call('GET', `/api/conversations/${chat.body.id}`, { token: lin.token })).body.title).toBe(
      '打开网页并截图',
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
