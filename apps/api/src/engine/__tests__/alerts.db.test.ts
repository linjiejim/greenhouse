import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { RealtimeEvent } from '@greenhouse/contract';
import { getDb, notifications, requests } from '@greenhouse/db';
import { createTestApp } from '../../testing.js';
import { notifyMissedReplies, REPLY_QUIET_MS, REPLY_WINDOW_MS } from '../alerts.js';
import { scriptedModel, text } from './model.js';

async function setup(replies = 3) {
  const model = scriptedModel(Array.from({ length: replies }, (_, index) => text(`Reply ${index + 1}.`)));
  const app = createTestApp({}, { languageModel: model.languageModel });
  const lin = await app.member('member', 'lin@acme.com');
  const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
  const mine = (memberId: string) => getDb().select().from(notifications).where(eq(notifications.memberId, memberId));
  /** A sweep as if `ms` had passed since now. */
  const sweep = (ms = REPLY_QUIET_MS + 1000) => notifyMissedReplies(app.services.notifications, Date.now() + ms);
  return { ...app, lin, main, mine, sweep };
}

describe('replies and mentions as notifications', () => {
  it('tells the people named in a room at once, and reading the room reads it', async () => {
    const { call, services, member, lin, mine } = await setup();
    const chen = await member('member', 'chen@acme.com');
    const wang = await member('member', 'wang@acme.com');
    const room = await call('POST', '/api/conversations', {
      token: lin.token,
      body: { kind: 'room', title: 'Launch', member_ids: [chen.id, wang.id] },
    });
    const events: RealtimeEvent[] = [];
    services.hub.subscribe(chen.id, (event) => events.push(event));

    const sent = await call('POST', `/api/conversations/${room.body.id}/messages`, {
      token: lin.token,
      // The sender and someone outside the room are never told.
      body: { content: '@chen can you look?', mentions: [chen.id, lin.id, 'mbr_nobody'] },
    });
    expect(sent.status).toBe(201);
    const [told] = await mine(chen.id);
    expect(told).toMatchObject({
      kind: 'mention',
      title: 'lin 在「Launch」里提到了你',
      body: '',
      targetType: 'conversation',
      targetId: room.body.id,
      payload: { message_id: sent.body.message.id, seq: sent.body.message.seq, from_member_id: lin.id },
      dedupeKey: `mention:${sent.body.message.id}`,
      readAt: null,
    });
    expect(await mine(lin.id)).toHaveLength(0);
    expect(await mine(wang.id)).toHaveLength(0);

    // Reading up to an earlier point leaves it unread; reading past it reads it, and says so.
    await call('POST', `/api/conversations/${room.body.id}/read`, {
      token: chen.token,
      body: { seq: sent.body.message.seq - 1 },
    });
    expect((await mine(chen.id))[0]!.readAt).toBeNull();
    await call('POST', `/api/conversations/${room.body.id}/read`, {
      token: chen.token,
      body: { seq: sent.body.message.seq },
    });
    expect((await mine(chen.id))[0]!.readAt).not.toBeNull();
    expect(events).toContainEqual({ type: 'notification.read', data: { notification_ids: [told!.id] } });
  });

  it('tells a member about a reply they missed, once, and only after a quiet minute', async () => {
    const { call, services, lin, main, mine, sweep } = await setup();
    await call('POST', `/api/conversations/${main.id}/messages`, { token: lin.token, body: { content: 'Hi' } });
    await services.engine.idle();

    expect(await sweep(0)).toBe(0);
    expect(await sweep()).toBe(1);
    expect(await sweep()).toBe(0);
    const [told] = await mine(lin.id);
    const page = await call('GET', `/api/conversations/${main.id}/messages`, { token: lin.token });
    const reply = page.body.items.at(-1);
    expect(told).toMatchObject({
      kind: 'reply',
      title: 'Greeny 回复了你',
      targetType: 'conversation',
      targetId: main.id,
      agentId: reply.agent_id,
      runId: null,
      payload: { message_id: reply.id, seq: reply.seq },
      dedupeKey: `reply:${reply.id}`,
    });
    // Too late: a reply from more than half an hour ago is never told.
    await getDb().delete(notifications).where(eq(notifications.id, told!.id));
    expect(await sweep(REPLY_WINDOW_MS + 60_000)).toBe(0);

    // Reading the conversation reads it.
    expect(await sweep()).toBe(1);
    await call('POST', `/api/conversations/${main.id}/read`, { token: lin.token, body: { seq: reply.seq } });
    expect((await mine(lin.id)).every((row) => row.readAt)).toBe(true);
  });

  it('stays quiet when the reply was read, a card waits, or the conversation is muted', async () => {
    const { call, services, lin, main, mine, sweep } = await setup();
    const ask = async () => {
      const sent = await call('POST', `/api/conversations/${main.id}/messages`, {
        token: lin.token,
        body: { content: 'Hi' },
      });
      await services.engine.idle();
      return sent.body.message.seq + 1;
    };

    // Read while it came in.
    const read = await ask();
    await call('POST', `/api/conversations/${main.id}/read`, { token: lin.token, body: { seq: read } });
    expect(await sweep()).toBe(0);

    // A card of theirs already called them.
    await ask();
    const card = await services.requests.create({
      memberId: lin.id,
      kind: 'question',
      subject: 'ask_user',
      title: 'A question',
      payload: {},
      conversationId: main.id,
    });
    expect(await sweep()).toBe(0);
    await getDb().update(requests).set({ status: 'expired' }).where(eq(requests.id, card.id));

    // Muted.
    await call('PATCH', `/api/conversations/${main.id}`, { token: lin.token, body: { muted: true } });
    expect(await sweep()).toBe(0);
    await call('PATCH', `/api/conversations/${main.id}`, { token: lin.token, body: { muted: false } });

    // Only the latest of several unread replies is told.
    const latest = await ask();
    expect(await sweep()).toBe(1);
    const replies = (await mine(lin.id)).filter((row) => row.kind === 'reply');
    expect(replies.map((row) => row.payload.seq)).toEqual([latest]);
  });

  it('in a room tells only the member the Agent answered', async () => {
    const { call, services, member, lin, mine, sweep } = await setup();
    const chen = await member('member', 'chen@acme.com');
    const room = await call('POST', '/api/conversations', {
      token: lin.token,
      body: { kind: 'room', title: 'Launch', member_ids: [chen.id], agent_ids: ['main'] },
    });
    await call('POST', `/api/conversations/${room.body.id}/messages`, {
      token: lin.token,
      body: { content: '@Greeny help', mentions: ['main'] },
    });
    await services.engine.idle();
    expect(await sweep()).toBe(1);
    expect(await mine(lin.id)).toMatchObject([{ kind: 'reply', title: 'Greeny 在「Launch」里回复了你' }]);
    expect(
      await getDb()
        .select()
        .from(notifications)
        .where(and(eq(notifications.memberId, chen.id), eq(notifications.kind, 'reply'))),
    ).toHaveLength(0);
  });
});
