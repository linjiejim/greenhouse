import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing.js';

describe('conversations', () => {
  it('gives each member one main thread and one thread per Agent, with a greeting', async () => {
    const { call, member } = createTestApp();
    const lin = await member();
    const list = await call('GET', '/api/conversations', { token: lin.token });
    expect(list.body.items).toEqual([
      expect.objectContaining({ kind: 'main', last_seq: 1, unread: 1, working: false }),
    ]);
    const writer = await call('POST', '/api/agents', { token: lin.token, body: { template_key: 'writer' } });
    const direct = await call('POST', '/api/conversations', {
      token: lin.token,
      body: { kind: 'direct', agent_id: writer.body.id },
    });
    expect(direct.status).toBe(201);
    expect(direct.body).toMatchObject({ kind: 'direct', agent_id: writer.body.id, last_seq: 1 });
    const again = await call('POST', '/api/conversations', {
      token: lin.token,
      body: { kind: 'direct', agent_id: writer.body.id },
    });
    expect(again.body.id).toBe(direct.body.id);
    // The Agent profile now points at its thread.
    expect((await call('GET', `/api/agents/${writer.body.id}`, { token: lin.token })).body.conversation_id).toBe(
      direct.body.id,
    );
    const messages = await call('GET', `/api/conversations/${direct.body.id}/messages`, { token: lin.token });
    expect(messages.body.items[0]).toMatchObject({
      role: 'assistant',
      agent_id: writer.body.id,
      event: { type: 'greeting' },
    });
    expect(messages.body.items[0].content).toContain('卷卷');
  });

  it('keeps conversations private to their members', async () => {
    const { call, member } = createTestApp();
    const lin = await member();
    const chen = await member();
    const chat = await call('POST', '/api/conversations', { token: lin.token, body: { kind: 'chat', title: 'Plans' } });
    expect((await call('GET', `/api/conversations/${chat.body.id}`, { token: chen.token })).status).toBe(404);
    expect((await call('GET', `/api/conversations/${chat.body.id}/messages`, { token: chen.token })).status).toBe(404);
    expect(
      (
        await call('POST', `/api/conversations/${chat.body.id}/messages`, {
          token: chen.token,
          body: { content: 'hi' },
        })
      ).status,
    ).toBe(404);
    const chenList = await call('GET', '/api/conversations', { token: chen.token });
    expect(chenList.body.items.map((c: { id: string }) => c.id)).not.toContain(chat.body.id);
  });

  it('pins, archives, mutes, renames and deletes', async () => {
    const { call, member } = createTestApp();
    const lin = await member();
    const a = await call('POST', '/api/conversations', { token: lin.token, body: { kind: 'chat', title: 'A' } });
    const b = await call('POST', '/api/conversations', { token: lin.token, body: { kind: 'chat', title: 'B' } });
    const pinned = await call('PATCH', `/api/conversations/${a.body.id}`, {
      token: lin.token,
      body: { pinned: true, muted: true, title: 'A2' },
    });
    expect(pinned.body).toMatchObject({ pinned: true, muted: true, title: 'A2' });
    const list = await call('GET', '/api/conversations', { token: lin.token });
    expect(list.body.items[0].id).toBe(a.body.id);
    expect(list.body.items.map((c: { id: string }) => c.id)).toContain(b.body.id);

    await call('PATCH', `/api/conversations/${b.body.id}`, { token: lin.token, body: { archived: true } });
    expect(
      (await call('GET', '/api/conversations', { token: lin.token })).body.items.map((c: { id: string }) => c.id),
    ).not.toContain(b.body.id);
    expect(
      (await call('GET', '/api/conversations?archived=true', { token: lin.token })).body.items.map(
        (c: { id: string }) => c.id,
      ),
    ).toEqual([b.body.id]);
    expect(
      (await call('GET', '/api/conversations?q=A2', { token: lin.token })).body.items.map((c: { id: string }) => c.id),
    ).toEqual([a.body.id]);

    const main = list.body.items.find((c: { kind: string }) => c.kind === 'main');
    expect((await call('DELETE', `/api/conversations/${main.id}`, { token: lin.token })).body.error.code).toBe(
      'conversation_protected',
    );
    expect((await call('DELETE', `/api/conversations/${a.body.id}`, { token: lin.token })).status).toBe(204);
    expect((await call('GET', `/api/conversations/${a.body.id}`, { token: lin.token })).status).toBe(404);
  });

  it('pages conversations by activity and messages by sequence', async () => {
    const { call, member, services } = createTestApp();
    const lin = await member();
    for (let index = 0; index < 4; index++) {
      await call('POST', '/api/conversations', { token: lin.token, body: { kind: 'chat', title: `chat ${index}` } });
    }
    const first = await call('GET', '/api/conversations?limit=2&kind=chat', { token: lin.token });
    const second = await call('GET', `/api/conversations?limit=2&kind=chat&cursor=${first.body.next_cursor}`, {
      token: lin.token,
    });
    const ids = [...first.body.items, ...second.body.items].map((c: { id: string }) => c.id);
    expect(new Set(ids).size).toBe(4);

    const chat = first.body.items[0];
    for (let index = 0; index < 5; index++) {
      await services.conversations.append(chat.id, {
        role: 'event',
        content: `line ${index}`,
        event: { type: 'note' },
      });
    }
    const latest = await call('GET', `/api/conversations/${chat.id}/messages?limit=2`, { token: lin.token });
    expect(latest.body.items.map((m: { seq: number }) => m.seq)).toEqual([4, 5]);
    const older = await call(
      'GET',
      `/api/conversations/${chat.id}/messages?limit=2&cursor=${latest.body.next_cursor}`,
      { token: lin.token },
    );
    expect(older.body.items.map((m: { seq: number }) => m.seq)).toEqual([2, 3]);
    const after = await call('GET', `/api/conversations/${chat.id}/messages?after=3`, { token: lin.token });
    expect(after.body.items.map((m: { seq: number }) => m.seq)).toEqual([4, 5]);

    await call('POST', `/api/conversations/${chat.id}/read`, { token: lin.token, body: { seq: 99 } });
    expect((await call('GET', `/api/conversations/${chat.id}`, { token: lin.token })).body.last_read_seq).toBe(5);
  });

  it('checks models, Agents and people when creating', async () => {
    const { call, member } = createTestApp();
    const lin = await member();
    const chen = await member();
    expect(
      (await call('POST', '/api/conversations', { token: lin.token, body: { kind: 'chat', model: 'nope/m' } })).status,
    ).toBe(400);
    const chensAgent = await call('POST', '/api/agents', { token: chen.token, body: { name: 'Hers' } });
    expect(
      (
        await call('POST', '/api/conversations', {
          token: lin.token,
          body: { kind: 'direct', agent_id: chensAgent.body.id },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call('POST', '/api/conversations', {
          token: lin.token,
          body: { kind: 'room', member_ids: ['mbr_nobody'] },
        })
      ).status,
    ).toBe(400);
    const room = await call('POST', '/api/conversations', {
      token: lin.token,
      body: { kind: 'room', member_ids: [chen.id] },
    });
    expect(room.body.members.map((m: { member_id: string; role: string }) => [m.member_id, m.role])).toEqual([
      [lin.id, 'owner'],
      [chen.id, 'member'],
    ]);
    // A room member who did not start it cannot delete it.
    expect((await call('DELETE', `/api/conversations/${room.body.id}`, { token: chen.token })).body.error.code).toBe(
      'not_owner',
    );
  });
});
