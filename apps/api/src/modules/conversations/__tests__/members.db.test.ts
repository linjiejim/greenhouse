import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RealtimeEvent } from '@greenhouse/contract';
import { auditEvents, conversationInbox, getDb, members, messages, requests, runs } from '@greenhouse/db';
import { gate, scriptedModel, text, toolCall } from '../../../engine/__tests__/model.js';
import { defineTool } from '../../../engine/tools/define.js';
import { createTestApp } from '../../../testing.js';

const noteTool = defineTool({
  name: 'note_write',
  description: 'Write a note.',
  input: z.object({ text: z.string() }),
  risk: 'write',
  async execute() {
    return { written: true };
  },
});

async function setup(scripts: Parameters<typeof scriptedModel>[0] = [text('ok')]) {
  const model = scriptedModel(scripts);
  const app = createTestApp({}, { languageModel: model.languageModel, tools: [noteTool] });
  const lin = await app.member();
  const chen = await app.member();
  const wu = await app.member();
  const room = (
    await app.call('POST', '/api/conversations', {
      token: lin.token,
      body: { kind: 'room', title: 'Launch', member_ids: [chen.id] },
    })
  ).body;
  return { ...app, model, lin, chen, wu, room };
}

describe('the people of a conversation', () => {
  it('lists people with their names and the Agents present', async () => {
    const { call, lin, chen, room } = await setup();
    const main = (await call('GET', '/api/conversations', { token: lin.token })).body.items.find(
      (c: { kind: string }) => c.kind === 'main',
    );
    const linsMain = (await call('GET', '/api/agents/main', { token: lin.token })).body;
    const thread = await call('GET', `/api/conversations/${main.id}/members`, { token: lin.token });
    expect(thread.body).toEqual({
      members: [expect.objectContaining({ id: lin.id, name: lin.name, role: 'owner', avatar_url: null })],
      agents: [{ id: linsMain.id, name: 'Greeny', role: linsMain.role, avatar: linsMain.avatar, owner_id: lin.id }],
    });
    const people = await call('GET', `/api/conversations/${room.id}/members`, { token: chen.token });
    expect(people.body.members.map((m: { id: string; role: string }) => [m.id, m.role])).toEqual([
      [lin.id, 'owner'],
      [chen.id, 'member'],
    ]);
    expect(people.body.agents).toEqual([]);
  });

  it('lets anyone in a room add people, and only an Agent’s owner add that Agent', async () => {
    const { call, services, lin, chen, wu, room } = await setup();
    const events: RealtimeEvent[] = [];
    services.hub.subscribe(wu.id, (event) => events.push(event));
    const linsAgent = await call('POST', '/api/agents', { token: lin.token, body: { name: 'Scout' } });

    const added = await call('POST', `/api/conversations/${room.id}/members`, {
      token: chen.token,
      body: { member_ids: [wu.id, lin.id], agent_ids: ['main'] },
    });
    expect(added.status).toBe(200);
    expect(added.body.members.map((m: { id: string }) => m.id)).toEqual([lin.id, chen.id, wu.id]);
    const chensMain = (await call('GET', '/api/agents/main', { token: chen.token })).body;
    expect(added.body.agents).toEqual([expect.objectContaining({ id: chensMain.id, owner_id: chen.id })]);
    // The new person hears about it and can read the room.
    expect(events).toContainEqual({ type: 'conversation.updated', data: { conversation_id: room.id, changes: {} } });
    expect((await call('GET', `/api/conversations/${room.id}/messages`, { token: wu.token })).status).toBe(200);
    const [audited] = await getDb().select().from(auditEvents).where(eq(auditEvents.action, 'conversation.member_add'));
    expect(audited).toMatchObject({
      actorId: chen.id,
      resourceType: 'member',
      resourceId: wu.id,
      scopeType: 'conversation',
      scopeId: room.id,
    });

    const someoneElses = await call('POST', `/api/conversations/${room.id}/members`, {
      token: chen.token,
      body: { agent_ids: [linsAgent.body.id] },
    });
    expect(someoneElses.status).toBe(404);
    await call('DELETE', `/api/agents/${linsAgent.body.id}`, { token: lin.token });
    const archived = await call('POST', `/api/conversations/${room.id}/members`, {
      token: lin.token,
      body: { agent_ids: [linsAgent.body.id] },
    });
    expect(archived.body.error.code).toBe('agent_archived');
    await getDb().update(members).set({ status: 'disabled' }).where(eq(members.id, wu.id));
    const disabled = await call('POST', `/api/conversations/${room.id}/members`, {
      token: lin.token,
      body: { member_ids: [wu.id] },
    });
    expect(disabled.status).toBe(400);
    expect((await call('POST', `/api/conversations/${room.id}/members`, { token: lin.token, body: {} })).status).toBe(
      400,
    );

    const chat = await call('POST', '/api/conversations', { token: lin.token, body: { kind: 'chat' } });
    const notRoom = await call('POST', `/api/conversations/${chat.body.id}/members`, {
      token: lin.token,
      body: { member_ids: [chen.id] },
    });
    expect(notRoom.body.error.code).toBe('not_a_room');
  });

  it('lets the owner remove people and anyone leave, with their Agents; a room keeps one person', async () => {
    const { call, services, lin, chen, wu, room } = await setup();
    await call('POST', `/api/conversations/${room.id}/members`, {
      token: chen.token,
      body: { member_ids: [wu.id], agent_ids: ['main'] },
    });
    const removeBy = (token: string, memberId: string) =>
      call('DELETE', `/api/conversations/${room.id}/members/${memberId}`, { token });

    expect((await removeBy(chen.token, wu.id)).body.error.code).toBe('not_owner');
    const wuEvents: RealtimeEvent[] = [];
    services.hub.subscribe(wu.id, (event) => wuEvents.push(event));
    expect((await removeBy(lin.token, wu.id)).status).toBe(204);
    expect(wuEvents).toEqual([{ type: 'conversation.updated', data: { conversation_id: room.id, changes: {} } }]);
    expect((await call('GET', `/api/conversations/${room.id}`, { token: wu.token })).status).toBe(404);
    expect((await removeBy(lin.token, wu.id)).status).toBe(404);

    // Chen leaves, and his Agent with him.
    expect((await removeBy(chen.token, chen.id)).status).toBe(204);
    const left = await call('GET', `/api/conversations/${room.id}/members`, { token: lin.token });
    expect(left.body).toEqual({ members: [expect.objectContaining({ id: lin.id, role: 'owner' })], agents: [] });
    expect((await removeBy(lin.token, lin.id)).body.error.code).toBe('last_member');

    const actions = await getDb()
      .select({ action: auditEvents.action, actor: auditEvents.actorId, target: auditEvents.resourceId })
      .from(auditEvents)
      .orderBy(asc(auditEvents.id));
    expect(actions).toEqual([
      { action: 'conversation.member_add', actor: chen.id, target: wu.id },
      { action: 'conversation.member_remove', actor: lin.id, target: wu.id },
      { action: 'conversation.leave', actor: chen.id, target: chen.id },
    ]);
  });

  it('hands the room to the next person when its owner leaves', async () => {
    const { call, lin, chen, room } = await setup();
    expect((await call('DELETE', `/api/conversations/${room.id}/members/${lin.id}`, { token: lin.token })).status).toBe(
      204,
    );
    const people = await call('GET', `/api/conversations/${room.id}/members`, { token: chen.token });
    expect(people.body.members).toEqual([expect.objectContaining({ id: chen.id, role: 'owner' })]);
    expect((await call('DELETE', `/api/conversations/${room.id}`, { token: chen.token })).status).toBe(204);
  });

  it('stops answering a person once they are gone: their queue drops and their cards expire', async () => {
    const hold = gate();
    const { call, services, model, lin, chen, room } = await setup([
      toolCall('note_write', { text: 'for Chen' }),
      { parts: text("Lin's answer."), gate: hold.promise },
      text('never'),
    ]);
    await call('POST', `/api/conversations/${room.id}/members`, { token: chen.token, body: { agent_ids: ['main'] } });
    await call('POST', `/api/conversations/${room.id}/members`, { token: lin.token, body: { agent_ids: ['main'] } });
    // Chen's Agent raises a card for Chen.
    const asked = await call('POST', `/api/conversations/${room.id}/messages`, {
      token: chen.token,
      body: { content: 'write it', mentions: ['main'] },
    });
    await services.engine.idle();
    const [card] = await getDb().select().from(requests).where(eq(requests.runId, asked.body.run_id));
    expect(card!.status).toBe('pending');
    // Lin's turn answers slowly; Chen's next message waits behind it.
    await call('POST', `/api/conversations/${room.id}/messages`, {
      token: lin.token,
      body: { content: 'mine first', mentions: ['main'] },
    });
    const queued = await call('POST', `/api/conversations/${room.id}/messages`, {
      token: chen.token,
      body: { content: 'and then me', mentions: ['main'] },
    });
    expect(queued.body.queued).toBe(true);

    expect(
      (await call('DELETE', `/api/conversations/${room.id}/members/${chen.id}`, { token: lin.token })).status,
    ).toBe(204);
    hold.open();
    await services.engine.idle();

    const [expired] = await getDb().select().from(requests).where(eq(requests.id, card!.id));
    expect(expired!.status).toBe('expired');
    const [waiting] = await getDb().select().from(runs).where(eq(runs.id, asked.body.run_id));
    expect(waiting!.status).toBe('canceled');
    const pending = await getDb().select().from(conversationInbox).where(eq(conversationInbox.conversationId, room.id));
    expect(pending.every((item) => item.consumedAt)).toBe(true);
    // Chen's Agent answered once (the card), Lin's once; nothing for the queued message.
    expect(model.calls()).toBe(2);
    const replies = await getDb()
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.conversationId, room.id), eq(messages.role, 'assistant')));
    expect(replies.map((row) => row.content)).toEqual(['', "Lin's answer."]);
  });

  it('stops the reply a person asked for when they leave', async () => {
    const hold = gate();
    const { call, services, model, chen, room } = await setup([{ parts: text('half an answer'), gate: hold.promise }]);
    await call('POST', `/api/conversations/${room.id}/members`, { token: chen.token, body: { agent_ids: ['main'] } });
    const asked = await call('POST', `/api/conversations/${room.id}/messages`, {
      token: chen.token,
      body: { content: 'think hard', mentions: ['main'] },
    });
    await expect.poll(() => model.calls()).toBe(1);
    expect(
      (await call('DELETE', `/api/conversations/${room.id}/members/${chen.id}`, { token: chen.token })).status,
    ).toBe(204);
    await services.engine.idle();
    hold.open();
    const [run] = await getDb().select().from(runs).where(eq(runs.id, asked.body.run_id));
    expect(run).toMatchObject({ status: 'canceled', desiredState: 'cancel' });
    const [reply] = await getDb().select().from(messages).where(eq(messages.runId, asked.body.run_id));
    expect(reply!.status).toBe('stopped');
  });

  it('never runs a turn for someone no longer in the conversation', async () => {
    const { call, services, model, lin, chen, room } = await setup([text('never')]);
    await call('POST', `/api/conversations/${room.id}/members`, { token: chen.token, body: { agent_ids: ['main'] } });
    const chensMain = (await call('GET', '/api/agents/main', { token: chen.token })).body;
    await call('DELETE', `/api/conversations/${room.id}/members/${chen.id}`, { token: lin.token });
    // Something left behind for Chen (a wake-up from elsewhere) still reaches the queue.
    await services.engine.deliver(room.id, { agentId: chensMain.id, memberId: chen.id, note: 'a process ended' });
    await services.engine.idle();
    expect(model.calls()).toBe(0);
    const [turn] = await getDb().select().from(runs).where(eq(runs.conversationId, room.id));
    expect(turn).toMatchObject({ status: 'failed', errorCode: 'not_in_conversation' });
    expect(
      await getDb()
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, room.id), eq(messages.role, 'assistant'))),
    ).toEqual([]);
  });

  it('tells the room who has read up to where, and keeps a read mark from going back', async () => {
    const { call, services, lin, chen, room } = await setup();
    const events: RealtimeEvent[] = [];
    services.hub.subscribe(lin.id, (event) => events.push(event));
    await call('POST', `/api/conversations/${room.id}/messages`, { token: lin.token, body: { content: 'hello' } });
    const seq = (await call('GET', `/api/conversations/${room.id}`, { token: lin.token })).body.last_seq;
    await call('POST', `/api/conversations/${room.id}/read`, { token: chen.token, body: { seq } });
    expect(events.filter((event) => event.type === 'read.updated')).toEqual([
      { type: 'read.updated', data: { conversation_id: room.id, member_id: chen.id, last_read_seq: seq } },
    ]);
    await call('POST', `/api/conversations/${room.id}/read`, { token: chen.token, body: { seq: 0 } });
    const people = await call('GET', `/api/conversations/${room.id}/members`, { token: lin.token });
    expect(people.body.members.find((m: { id: string }) => m.id === chen.id).last_read_seq).toBe(seq);

    // Outside rooms nobody else is there: no event.
    const main = (await call('GET', '/api/conversations', { token: lin.token })).body.items.find(
      (c: { kind: string }) => c.kind === 'main',
    );
    events.length = 0;
    await call('POST', `/api/conversations/${main.id}/read`, { token: lin.token, body: { seq: 1 } });
    expect(events.filter((event) => event.type === 'read.updated')).toEqual([]);
  });
});
