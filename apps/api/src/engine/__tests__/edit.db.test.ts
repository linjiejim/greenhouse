/**
 * Editing the last message and regenerating the last reply: only the member's own latest
 * exchange, only while no turn answers, and always answered again through the engine's queue.
 */

import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RealtimeEvent } from '@greenhouse/contract';
import { conversations, getDb, messageReceipts, messages, requests, runs, runSteps } from '@greenhouse/db';
import { createTestApp } from '../../testing.js';
import { defineTool } from '../tools/define.js';
import { gate, scriptedModel, text, toolCall } from './model.js';

/** A write tool: it runs only once the member approves. */
function noteTool(ran: unknown[]) {
  return defineTool({
    name: 'note_write',
    describe: async () => ({ summary: '写入共享笔记', details: [] }),
    description: 'Write a note into the shared notebook.',
    input: z.object({ text: z.string() }),
    risk: 'write',
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
  const events: RealtimeEvent[] = [];
  app.services.hub.subscribe(lin.id, (event) => events.push(event));
  const send = async (content: string, token = lin.token, conversationId = main.id, mentions: string[] = []) => {
    const sent = await app.call('POST', `/api/conversations/${conversationId}/messages`, {
      token,
      body: { content, mentions },
    });
    await app.services.engine.idle();
    return sent.body;
  };
  const transcript = async (conversationId = main.id) =>
    getDb().select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.seq));
  return { ...app, model, lin, main, ran, events, send, transcript };
}

describe('editing the last message', () => {
  it('replaces it, removes the reply for good and answers the new text', async () => {
    const { call, services, model, lin, main, events, send, transcript } = await setup([
      text('Kyoto in April is lovely.'),
      text('Osaka has great food.'),
    ]);
    const sent = await send('Plan a trip to Kyoto');
    const [, , oldReply] = await transcript();
    expect(oldReply).toMatchObject({ seq: 3, content: 'Kyoto in April is lovely.' });

    expect(
      await getDb()
        .select()
        .from(runSteps)
        .where(and(eq(runSteps.runId, sent.run_id), eq(runSteps.kind, 'model'))),
    ).not.toHaveLength(0);
    const edited = await call('PATCH', `/api/conversations/${main.id}/messages/${sent.message.id}`, {
      token: lin.token,
      body: { content: 'Plan a trip to Osaka' },
    });
    expect(edited.status).toBe(200);
    expect(
      await getDb()
        .select()
        .from(runSteps)
        .where(and(eq(runSteps.runId, sent.run_id), eq(runSteps.kind, 'model'))),
    ).toHaveLength(0);
    expect(edited.body).toMatchObject({
      message: { id: sent.message.id, seq: 2, content: 'Plan a trip to Osaka' },
      deleted_message_ids: [oldReply!.id],
      queued: false,
    });
    expect(edited.body.message.edited_at).toBeTruthy();
    await services.engine.idle();

    // The removed reply's number is not given out again; the new reply comes after it.
    const after = await transcript();
    expect(after.map((row) => [row.seq, row.role, row.content])).toEqual([
      [1, 'assistant', expect.stringContaining('Greeny')],
      [2, 'user', 'Plan a trip to Osaka'],
      [4, 'assistant', 'Osaka has great food.'],
    ]);
    expect(after[2]!.runId).toBe(edited.body.run_id);
    // The model saw the new text only, not the old one or its answer.
    const prompt = JSON.stringify(model.prompts[1]);
    expect(prompt).toContain('Plan a trip to Osaka');
    expect(prompt).not.toContain('Kyoto');
    const receipts = await getDb().select().from(messageReceipts).where(eq(messageReceipts.messageId, sent.message.id));
    expect(receipts.map((row) => row.status)).toEqual(['answered']);

    const deleted = events.findIndex((event) => event.type === 'message.deleted');
    expect(events[deleted]).toEqual({
      type: 'message.deleted',
      data: { conversation_id: main.id, message_id: oldReply!.id },
    });
    expect(events.slice(deleted + 1).find((event) => event.type === 'message.updated')).toMatchObject({
      data: { message: { id: sent.message.id, content: 'Plan a trip to Osaka' } },
    });
    const page = await call('GET', `/api/conversations/${main.id}/messages`, { token: lin.token });
    expect(page.body.items.map((m: { seq: number }) => m.seq)).toEqual([1, 2, 4]);
  });

  it('waits for no turn and changes only my latest message', async () => {
    const hold = gate();
    const { call, services, member, lin, main, send, transcript } = await setup([
      { parts: text('First.'), gate: hold.promise },
      text('Second.'),
    ]);
    const first = await call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'one' },
    });
    const busy = await call('PATCH', `/api/conversations/${main.id}/messages/${first.body.message.id}`, {
      token: lin.token,
      body: { content: 'uno' },
    });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('conversation_busy');
    hold.open();
    await services.engine.idle();

    const second = await send('two');
    const edit = (id: string, content = 'changed', token = lin.token) =>
      call('PATCH', `/api/conversations/${main.id}/messages/${id}`, { token, body: { content } });
    expect((await edit(first.body.message.id)).body.error.code).toBe('not_latest');
    const [greeting] = await transcript();
    expect((await edit(greeting!.id)).body.error.code).toBe('not_editable');
    expect((await edit(second.message.id, '   ')).status).toBe(400);
    expect((await edit('msg_nope')).status).toBe(404);
    const chen = await member();
    expect((await edit(second.message.id, 'mine now', chen.token)).status).toBe(404);
    // Nothing changed.
    expect((await transcript()).map((row) => row.content)).toEqual([
      expect.stringContaining('Greeny'),
      'one',
      'First.',
      'two',
      'Second.',
    ]);
  });

  it('expires the cards of a removed reply without waking the Agent', async () => {
    const { call, services, model, lin, main, ran, send } = await setup([
      toolCall('note_write', { text: 'Buy milk' }),
      text('No note then.'),
    ]);
    const sent = await send('note: buy milk');
    const [card] = await getDb().select().from(requests).where(eq(requests.runId, sent.run_id));
    expect(card).toMatchObject({ status: 'pending' });

    const edited = await call('PATCH', `/api/conversations/${main.id}/messages/${sent.message.id}`, {
      token: lin.token,
      body: { content: 'never mind the note' },
    });
    expect(edited.status).toBe(200);
    await services.engine.idle();

    const [expired] = await getDb().select().from(requests).where(eq(requests.id, card!.id));
    expect(expired!.status).toBe('expired');
    const [step] = await getDb().select().from(runSteps).where(eq(runSteps.requestId, card!.id));
    expect(step!.status).toBe('skipped');
    const [old] = await getDb().select().from(runs).where(eq(runs.id, sent.run_id));
    expect(old).toMatchObject({ status: 'canceled', waitReason: null });
    // One turn for the first message, one for the edited one; the expiry woke nobody.
    expect(model.calls()).toBe(2);
    const approve = await call('POST', `/api/requests/${card!.id}/approve`, { token: lin.token });
    expect(approve.body.error.code).toBe('request_settled');
    expect(ran).toEqual([]);
    expect((await call('GET', '/api/notifications/summary', { token: lin.token })).body.needs_you).toBe(0);
  });

  it('removes a reply still streaming after its lease was taken over, and it never comes back', async () => {
    const hold = gate();
    const { call, services, model, lin, main, events, transcript } = await setup([
      { parts: text('An answer that is still being written.'), gate: hold.promise },
      text('The new answer.'),
    ]);
    const sent = await call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'question' },
    });
    // The model is streaming the reply (and holds it at the gate).
    await expect.poll(() => model.calls()).toBe(1);
    const [, , streaming] = await transcript();
    expect(streaming!.status).toBe('streaming');
    // Another process swept the turn as if this one had died.
    await getDb()
      .update(runs)
      .set({ status: 'failed', leaseOwner: null, errorCode: 'interrupted' })
      .where(eq(runs.id, sent.body.run_id));

    const edited = await call('PATCH', `/api/conversations/${main.id}/messages/${sent.body.message.id}`, {
      token: lin.token,
      body: { content: 'question, again' },
    });
    expect(edited.body.deleted_message_ids).toEqual([streaming!.id]);
    hold.open();
    await services.engine.idle();

    const rows = await transcript();
    expect(rows.map((row) => row.content)).toEqual([
      expect.stringContaining('Greeny'),
      'question, again',
      'The new answer.',
    ]);
    expect(rows.some((row) => row.id === streaming!.id)).toBe(false);
    const afterDelete = events.slice(events.findIndex((event) => event.type === 'message.deleted') + 1);
    expect(
      afterDelete.some(
        (event) =>
          (event.type === 'message.updated' || event.type === 'message.created') &&
          event.data.message.id === streaming!.id,
      ),
    ).toBe(false);
    const [receipt] = await getDb()
      .select()
      .from(messageReceipts)
      .where(eq(messageReceipts.messageId, sent.body.message.id));
    expect(receipt!.status).toBe('answered');
  });

  it('keeps the rolling summary true: a summarised message cannot change', async () => {
    const { call, lin, main, send } = await setup([text('Noted.')]);
    const sent = await send('remember this');
    await getDb().update(conversations).set({ digestUptoSeq: 10 }).where(eq(conversations.id, main.id));
    const edited = await call('PATCH', `/api/conversations/${main.id}/messages/${sent.message.id}`, {
      token: lin.token,
      body: { content: 'something else' },
    });
    expect(edited.body.error.code).toBe('message_summarized');
  });
});

describe('regenerating the last reply', () => {
  it('writes it again for the same question', async () => {
    const { call, services, model, lin, main, send, transcript } = await setup([
      text('Answer A.'),
      text('Answer B.'),
      text('Answer C.'),
    ]);
    const sent = await send('a question');
    const [, question, reply] = await transcript();
    const regenerated = await call('POST', `/api/conversations/${main.id}/messages/${reply!.id}/regenerate`, {
      token: lin.token,
    });
    expect(regenerated.status).toBe(200);
    expect(regenerated.body).toMatchObject({ deleted_message_ids: [reply!.id], queued: false });
    await services.engine.idle();
    expect((await transcript()).map((row) => [row.seq, row.content])).toEqual([
      [1, expect.stringContaining('Greeny')],
      [2, 'a question'],
      [4, 'Answer B.'],
    ]);
    expect(JSON.stringify(model.prompts[1])).not.toContain('Answer A.');
    const [run] = await getDb().select().from(runs).where(eq(runs.id, regenerated.body.run_id));
    expect(run).toMatchObject({ status: 'succeeded', input: expect.objectContaining({ message_ids: [question!.id] }) });
    expect(sent.run_id).not.toBe(regenerated.body.run_id);

    const regenerate = (id: string) =>
      call('POST', `/api/conversations/${main.id}/messages/${id}/regenerate`, { token: lin.token });
    // Only a reply from a turn: not my message, not the greeting.
    expect((await regenerate(question!.id)).body.error.code).toBe('not_regenerable');
    const [greeting] = await transcript();
    expect((await regenerate(greeting!.id)).body.error.code).toBe('not_regenerable');
    // Only the last reply.
    const newer = (await transcript()).at(-1)!;
    await send('another question');
    expect((await regenerate(newer.id)).body.error.code).toBe('not_latest');
  });

  it('wakes the Agent again with the same note after a decision, without running the action twice', async () => {
    const { call, services, lin, main, ran, send, transcript } = await setup([
      toolCall('note_write', { text: 'Buy milk' }),
      text('Written.'),
      text('Written, and filed under groceries.'),
    ]);
    const sent = await send('note: buy milk');
    const [card] = await getDb().select().from(requests).where(eq(requests.runId, sent.run_id));
    await call('POST', `/api/requests/${card!.id}/approve`, { token: lin.token });
    await services.engine.idle();
    const before = await transcript();
    expect(before.slice(2).map((row) => [row.role, row.content])).toEqual([
      ['assistant', ''],
      ['event', '已批准：写入共享笔记'],
      ['assistant', 'Written.'],
    ]);

    const regenerated = await call('POST', `/api/conversations/${main.id}/messages/${before.at(-1)!.id}/regenerate`, {
      token: lin.token,
    });
    expect(regenerated.status).toBe(200);
    await services.engine.idle();
    const after = await transcript();
    expect(after.slice(2).map((row) => [row.role, row.content])).toEqual([
      ['assistant', ''],
      ['event', '已批准：写入共享笔记'],
      ['assistant', 'Written, and filed under groceries.'],
    ]);
    const [run] = await getDb().select().from(runs).where(eq(runs.id, regenerated.body.run_id));
    expect(run!.input).toMatchObject({ reason: 'continue', note: expect.stringContaining('approved') });
    expect(ran).toEqual([{ text: 'Buy milk' }]);
  });
});

describe('in a room', () => {
  it("changes only the asker's own exchange, and `main` is the sender's own main Agent", async () => {
    const { call, services, member, lin, send, transcript } = await setup([
      text("Lin's answer."),
      text("Chen's answer."),
      text("Chen's answer, again."),
    ]);
    const chen = await member();
    const room = await call('POST', '/api/conversations', {
      token: lin.token,
      body: { kind: 'room', member_ids: [chen.id], agent_ids: ['main'] },
    });
    await call('POST', `/api/conversations/${room.body.id}/members`, {
      token: chen.token,
      body: { agent_ids: ['main'] },
    });
    const asked = await send('help me', lin.token, room.body.id, ['main']);
    await send('hello everyone', chen.token, room.body.id);
    const rows = await transcript(room.body.id);
    const linsReply = rows.find((row) => row.content === "Lin's answer.")!;
    expect((await call('GET', '/api/agents/main', { token: lin.token })).body.id).toBe(linsReply.agentId);

    // Chen wrote after Lin's exchange: it is no longer the latest.
    const editLins = await call('PATCH', `/api/conversations/${room.body.id}/messages/${asked.message.id}`, {
      token: lin.token,
      body: { content: 'help me please' },
    });
    expect(editLins.body.error.code).toBe('not_latest');
    const regenerateLins = await call(
      'POST',
      `/api/conversations/${room.body.id}/messages/${linsReply.id}/regenerate`,
      { token: lin.token },
    );
    expect(regenerateLins.body.error.code).toBe('not_latest');

    // Chen's `main` is Chen's own Agent.
    await send('and me?', chen.token, room.body.id, ['main']);
    const chensReply = (await transcript(room.body.id)).at(-1)!;
    expect(chensReply.content).toBe("Chen's answer.");
    expect((await call('GET', '/api/agents/main', { token: chen.token })).body.id).toBe(chensReply.agentId);
    const byLin = await call('POST', `/api/conversations/${room.body.id}/messages/${chensReply.id}/regenerate`, {
      token: lin.token,
    });
    expect(byLin.body.error.code).toBe('not_regenerable');
    const byChen = await call('POST', `/api/conversations/${room.body.id}/messages/${chensReply.id}/regenerate`, {
      token: chen.token,
    });
    expect(byChen.status).toBe(200);
    await services.engine.idle();
    expect((await transcript(room.body.id)).at(-1)!.content).toBe("Chen's answer, again.");
    const [kept] = await getDb()
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, room.body.id), eq(messages.id, linsReply.id)));
    expect(kept).toBeTruthy();
  });
});
