import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb, members } from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';

async function setup() {
  const app = createTestApp();
  const lin = await app.member('member', 'lin@example.com');
  const chen = await app.member('member', 'chen@example.com');
  await getDb().update(members).set({ name: 'Kyoko Tanaka' }).where(eq(members.id, chen.id));
  const chat = (
    await app.call('POST', '/api/conversations', { token: lin.token, body: { kind: 'chat', title: 'Kyoto trip' } })
  ).body;
  const said = await app.services.conversations.append(chat.id, {
    role: 'user',
    authorMemberId: lin.id,
    content: `${'Some context first. '.repeat(10)}Book the ryokan in KYOTO for April, near the station.`,
  });
  const guide = (
    await app.call('POST', '/api/agents', { token: lin.token, body: { name: 'Guide', role: 'Kyoto travel planner' } })
  ).body;
  // Chen's own conversation never shows up for Lin.
  const secret = (
    await app.call('POST', '/api/conversations', { token: chen.token, body: { kind: 'chat', title: 'Kyoto secret' } })
  ).body;
  await app.services.conversations.append(secret.id, {
    role: 'user',
    authorMemberId: chen.id,
    content: 'my Kyoto surprise',
  });
  const search = (query: string, token = lin.token) => app.call('GET', `/api/search?${query}`, { token });
  return { ...app, lin, chen, chat, said, guide, search };
}

describe('⌘K search', () => {
  it('finds my conversations, their messages, my Agents and people, a few of each', async () => {
    const { lin, chen, chat, said, guide, search } = await setup();
    const found = await search('q=kyo');
    expect(found.status).toBe(200);
    expect(found.body.items).toEqual([
      { kind: 'conversations', id: chat.id, title: 'Kyoto trip', conversation_id: chat.id, agent_id: chat.agent_id },
      {
        kind: 'messages',
        id: said.id,
        title: 'Kyoto trip',
        snippet: expect.stringContaining('ryokan in KYOTO'),
        conversation_id: chat.id,
        seq: said.seq,
      },
      { kind: 'agents', id: guide.id, title: 'Guide', snippet: 'Kyoto travel planner', agent_id: guide.id },
      { kind: 'members', id: chen.id, title: 'Kyoko Tanaka', snippet: 'chen@example.com' },
    ]);
    const message = found.body.items[1];
    expect(message.snippet.length).toBeLessThanOrEqual(122);
    expect(message.snippet.startsWith('…')).toBe(true);
    expect(JSON.stringify(found.body)).not.toContain('secret');
    expect(JSON.stringify(found.body)).not.toContain(lin.id);
  });

  it('narrows to the kinds asked for, caps each kind, and treats wildcards as text', async () => {
    const { search, guide } = await setup();
    expect((await search('q=planner&kinds=agents')).body.items.map((item: { id: string }) => item.id)).toEqual([
      guide.id,
    ]);
    const people = await search('q=example.com&kinds=members&limit=1');
    expect(people.body.items).toHaveLength(1);
    expect((await search('q=%25&kinds=conversations,messages,members')).body.items).toEqual([]);
    expect((await search('q=_&kinds=agents')).body.items).toEqual([]);
    expect(
      (await search('q=kyoto&kinds=agents,members')).body.items.map((item: { kind: string }) => item.kind),
    ).toEqual(['agents']);
  });

  it('checks the query', async () => {
    const { search, call } = await setup();
    expect((await search('q=')).status).toBe(400);
    expect((await search(`q=${'x'.repeat(101)}`)).status).toBe(400);
    expect((await search('q=kyoto&kinds=nothing')).status).toBe(400);
    expect((await search('q=kyoto&limit=50')).status).toBe(400);
    expect((await call('GET', '/api/search?q=kyoto')).status).toBe(401);
  });
});
