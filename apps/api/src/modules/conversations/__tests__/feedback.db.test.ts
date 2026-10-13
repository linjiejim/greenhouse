import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb, messageFeedback } from '@greenhouse/db';
import { scriptedModel, text } from '../../../engine/__tests__/model.js';
import { createTestApp } from '../../../testing.js';

async function setup() {
  const model = scriptedModel([text('Here you go.')]);
  const app = createTestApp({}, { languageModel: model.languageModel });
  const lin = await app.member();
  const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
  const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
    token: lin.token,
    body: { content: 'hello' },
  });
  await app.services.engine.idle();
  const page = await app.call('GET', `/api/conversations/${main.id}/messages`, { token: lin.token });
  const reply = page.body.items.find((m: { run_id: string | null }) => m.run_id === sent.body.run_id);
  return { ...app, lin, main, sent: sent.body, greeting: page.body.items[0], reply };
}

describe('feedback on replies', () => {
  it('rates a reply once per person, shows my rating in the list and records the version that wrote it', async () => {
    const { call, lin, main, reply, greeting } = await setup();
    const rate = (body: unknown, id = reply.id) =>
      call('PUT', `/api/conversations/${main.id}/messages/${id}/feedback`, { token: lin.token, body });

    expect((await rate({ rating: 1 })).body).toEqual({ rating: 1, comment: '' });
    const listed = await call('GET', `/api/conversations/${main.id}/messages`, { token: lin.token });
    expect(listed.body.items.map((m: { my_rating: number | null }) => m.my_rating)).toEqual([null, null, 1]);

    // A newer version of the Agent does not change who wrote this reply.
    await call('PATCH', '/api/agents/main', { token: lin.token, body: { role: 'Planner' } });
    expect((await rate({ rating: -1, comment: '  Too short.  ' })).body).toEqual({ rating: -1, comment: 'Too short.' });
    const rows = await getDb().select().from(messageFeedback).where(eq(messageFeedback.messageId, reply.id));
    expect(rows).toEqual([
      expect.objectContaining({ memberId: lin.id, rating: -1, agentId: reply.agent_id, agentVersion: 1 }),
    ]);

    // A message without a turn falls back to the Agent's current version.
    await rate({ rating: 1 }, greeting.id);
    const [onGreeting] = await getDb()
      .select()
      .from(messageFeedback)
      .where(and(eq(messageFeedback.messageId, greeting.id), eq(messageFeedback.memberId, lin.id)));
    expect(onGreeting!.agentVersion).toBe(2);

    expect((await rate({ rating: 0 })).body).toEqual({ rating: 0, comment: '' });
    const after = await call('GET', `/api/conversations/${main.id}/messages`, { token: lin.token });
    expect(after.body.items.map((m: { my_rating: number | null }) => m.my_rating)).toEqual([1, null, null]);
  });

  it('rates only replies, in conversations I am in, with a short comment', async () => {
    const { call, member, lin, main, sent, reply } = await setup();
    const rate = (body: unknown, id = reply.id, token = lin.token, conversationId = main.id) =>
      call('PUT', `/api/conversations/${conversationId}/messages/${id}/feedback`, { token, body });
    expect((await rate({ rating: 1 }, sent.message.id)).body.error.code).toBe('not_a_reply');
    expect((await rate({ rating: 2 })).status).toBe(400);
    expect((await rate({ rating: -1, comment: 'x'.repeat(501) })).status).toBe(400);
    expect((await rate({ rating: 1 }, 'msg_nope')).status).toBe(404);
    const chen = await member();
    expect((await rate({ rating: 1 }, reply.id, chen.token)).status).toBe(404);
    // A message id from another conversation is not found here.
    const chat = await call('POST', '/api/conversations', { token: lin.token, body: { kind: 'chat' } });
    expect((await rate({ rating: 1 }, reply.id, lin.token, chat.body.id)).status).toBe(404);
  });

  it('keeps each person in a room to their own rating', async () => {
    const model = scriptedModel([text('For everyone.')]);
    const app = createTestApp({}, { languageModel: model.languageModel });
    const lin = await app.member();
    const chen = await app.member();
    const room = await app.call('POST', '/api/conversations', {
      token: lin.token,
      body: { kind: 'room', member_ids: [chen.id], agent_ids: ['main'] },
    });
    await app.call('POST', `/api/conversations/${room.body.id}/messages`, {
      token: lin.token,
      body: { content: 'go', mentions: ['main'] },
    });
    await app.services.engine.idle();
    const listed = await app.call('GET', `/api/conversations/${room.body.id}/messages`, { token: chen.token });
    const reply = listed.body.items.at(-1);
    await app.call('PUT', `/api/conversations/${room.body.id}/messages/${reply.id}/feedback`, {
      token: chen.token,
      body: { rating: -1 },
    });
    await app.call('PUT', `/api/conversations/${room.body.id}/messages/${reply.id}/feedback`, {
      token: lin.token,
      body: { rating: 1 },
    });
    const mine = async (token: string) =>
      (await app.call('GET', `/api/conversations/${room.body.id}/messages`, { token })).body.items.at(-1).my_rating;
    expect(await mine(lin.token)).toBe(1);
    expect(await mine(chen.token)).toBe(-1);
  });
});
