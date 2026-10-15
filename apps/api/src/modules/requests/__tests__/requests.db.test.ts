import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agentVersions, getDb, messages, requests, runs, runSteps } from '@greenhouse/db';
import { lastUserText, scriptedModel, text, toolCall } from '../../../engine/__tests__/model.js';
import { defineTool } from '../../../engine/tools/define.js';
import { createTestApp } from '../../../testing.js';

/** A write tool that records what it ran with. */
function noteTool(ran: unknown[]) {
  return defineTool({
    name: 'note_write',
    description: 'Write a note into the shared notebook.',
    input: z.object({ text: z.string() }),
    risk: 'write',
    describe: (args, ctx) => ({
      summary: ctx.locale === 'zh' ? '写一条笔记' : 'write a note',
      details: [{ label: 'text', value: args.text }],
    }),
    async execute(args) {
      ran.push(args);
      return { written: true };
    },
  });
}

async function setup(scripts: Parameters<typeof scriptedModel>[0]) {
  const ran: unknown[] = [];
  const model = scriptedModel(scripts);
  const app = createTestApp({}, { languageModel: model.languageModel, tools: [noteTool(ran)] });
  const lin = await app.member();
  const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
  const send = async (content: string) => {
    const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content },
    });
    await app.services.engine.idle();
    return sent.body;
  };
  return { ...app, model, lin, main, ran, send };
}

describe('needs you', () => {
  it('asks before a write, runs exactly what was approved, and wakes the Agent with the result', async () => {
    const { call, services, model, lin, main, ran, send } = await setup([
      toolCall('note_write', { text: 'Buy milk' }),
      text('Written.'),
    ]);
    const sent = await send('note: buy milk');
    expect(ran).toEqual([]);
    const [run] = await getDb().select().from(runs).where(eq(runs.id, sent.run_id));
    expect(run).toMatchObject({ status: 'waiting', waitReason: 'request' });
    const pending = await call('GET', '/api/requests', { token: lin.token });
    expect(pending.body.items).toEqual([
      expect.objectContaining({
        kind: 'approval',
        subject: 'tool_write',
        status: 'pending',
        title: 'Greeny 请你批准：写一条笔记',
        conversation_id: main.id,
        run_id: sent.run_id,
      }),
    ]);
    const card = pending.body.items[0];
    expect(card.payload.details).toEqual([{ label: 'text', value: 'Buy milk' }]);
    expect((await call('GET', '/api/notifications/summary', { token: lin.token })).body).toMatchObject({
      needs_you: 1,
      unread: 1,
    });
    expect((await call('GET', `/api/conversations/${main.id}`, { token: lin.token })).body.pending_requests).toBe(1);
    const [step] = await getDb()
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, sent.run_id), eq(runSteps.kind, 'tool')));
    expect(step).toMatchObject({ status: 'pending', requestId: card.id });

    const approved = await call('POST', `/api/requests/${card.id}/approve`, { token: lin.token });
    expect(approved.body.status).toBe('approved');
    await services.engine.idle();
    expect(ran).toEqual([{ text: 'Buy milk' }]);
    const [done] = await getDb().select().from(runSteps).where(eq(runSteps.id, step!.id));
    expect(done).toMatchObject({ status: 'succeeded', output: { written: true } });
    const [finished] = await getDb().select().from(runs).where(eq(runs.id, sent.run_id));
    expect(finished!.status).toBe('succeeded');
    const transcript = await getDb()
      .select()
      .from(messages)
      .where(eq(messages.conversationId, main.id))
      .orderBy(asc(messages.seq));
    expect(transcript.map((m) => [m.role, m.content])).toEqual(
      expect.arrayContaining([
        ['event', '已批准：写一条笔记'],
        ['assistant', 'Written.'],
      ]),
    );
    expect(lastUserText(model.prompts[1])).toContain('The member approved "写一条笔记" and it ran');
    expect((await call('GET', '/api/notifications/summary', { token: lin.token })).body).toMatchObject({
      needs_you: 0,
      unread: 0,
    });

    // Decided once.
    const again = await call('POST', `/api/requests/${card.id}/approve`, { token: lin.token });
    expect(again.body.error.code).toBe('request_settled');
  });

  it('declines with a reason and tells the Agent not to retry', async () => {
    const { call, services, model, lin, member, ran, send } = await setup([
      toolCall('note_write', { text: 'Spam' }),
      text('Understood.'),
    ]);
    await send('write spam');
    const card = (await call('GET', '/api/requests', { token: lin.token })).body.items[0];
    const chen = await member();
    expect((await call('POST', `/api/requests/${card.id}/reject`, { token: chen.token, body: {} })).status).toBe(404);
    expect(
      (await call('POST', `/api/requests/${card.id}/answer`, { token: lin.token, body: { answers: {} } })).body.error
        .code,
    ).toBe('wrong_decision');
    await call('POST', `/api/requests/${card.id}/reject`, { token: lin.token, body: { reason: 'not now' } });
    await services.engine.idle();
    expect(ran).toEqual([]);
    const [step] = await getDb().select().from(runSteps).where(eq(runSteps.requestId, card.id));
    expect(step!.status).toBe('skipped');
    expect(lastUserText(model.prompts[1])).toContain('declined "写一条笔记": not now. Do not retry');
  });

  it('asks the member a question and continues with the answer', async () => {
    const { call, services, model, lin, send } = await setup([
      toolCall('ask_user', {
        question: 'Which city?',
        fields: [{ key: 'city', label: 'City', type: 'choice', options: ['Kyoto', 'Osaka'] }],
      }),
      text('Kyoto it is.'),
    ]);
    await send('plan a trip');
    const card = (await call('GET', '/api/requests', { token: lin.token })).body.items[0];
    expect(card).toMatchObject({ kind: 'question', title: 'Which city?' });
    expect(
      (
        await call('POST', `/api/requests/${card.id}/answer`, {
          token: lin.token,
          body: { answers: { city: 'Tokyo' } },
        })
      ).status,
    ).toBe(400);
    expect(
      (await call('POST', `/api/requests/${card.id}/answer`, { token: lin.token, body: { answers: {} } })).status,
    ).toBe(400);
    const answered = await call('POST', `/api/requests/${card.id}/answer`, {
      token: lin.token,
      body: { answers: { city: 'Kyoto' } },
    });
    expect(answered.body).toMatchObject({ status: 'answered', result: { answers: { city: 'Kyoto' } } });
    await services.engine.idle();
    expect(lastUserText(model.prompts[1])).toContain('City: Kyoto');
  });

  it('lets the Agent propose new instructions that apply only once accepted', async () => {
    const { call, services, lin, send } = await setup([
      toolCall('self', { instructions: 'Always answer in haiku.', reason: 'The member likes haiku.' }),
      text('Proposed.'),
    ]);
    const sent = await send('please use haiku from now on');
    const [run] = await getDb().select().from(runs).where(eq(runs.id, sent.run_id));
    // A proposal does not hold the turn.
    expect(run!.status).toBe('succeeded');
    const card = (await call('GET', '/api/requests', { token: lin.token })).body.items[0];
    expect(card).toMatchObject({ kind: 'proposal', subject: 'instructions_update', title: 'Greeny 想修改自己的指令' });
    await call('POST', `/api/requests/${card.id}/approve`, { token: lin.token });
    await services.engine.idle();
    const main = await call('GET', '/api/agents/main', { token: lin.token });
    expect(main.body).toMatchObject({ instructions: 'Always answer in haiku.', current_version: 2 });
    const [version] = await getDb()
      .select()
      .from(agentVersions)
      .where(and(eq(agentVersions.agentId, main.body.id), eq(agentVersions.version, 2)));
    expect(version!.changeNote).toBe('The member likes haiku.');
  });

  it('expires cards that wait too long and closes their run', async () => {
    const { call, services, lin, send } = await setup([toolCall('note_write', { text: 'Later' })]);
    const sent = await send('note later');
    const card = (await call('GET', '/api/requests', { token: lin.token })).body.items[0];
    await getDb()
      .update(requests)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(requests.id, card.id));
    expect((await call('POST', `/api/requests/${card.id}/approve`, { token: lin.token })).body.error.code).toBe(
      'request_expired',
    );
    await services.engine.sweep();
    await services.engine.idle();
    const [expired] = await getDb().select().from(requests).where(eq(requests.id, card.id));
    expect(expired!.status).toBe('expired');
    const [run] = await getDb().select().from(runs).where(eq(runs.id, sent.run_id));
    expect(run!.status).toBe('succeeded');
    const lines = await getDb()
      .select()
      .from(messages)
      .where(and(eq(messages.runId, sent.run_id)));
    expect(lines).toHaveLength(1);
    expect((await call('GET', '/api/requests?state=all', { token: lin.token })).body.items[0].status).toBe('expired');
    expect((await call('GET', '/api/notifications', { token: lin.token })).body.items).toEqual([]);
  });
});
