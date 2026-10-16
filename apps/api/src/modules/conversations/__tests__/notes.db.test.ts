import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { RealtimeEvent } from '@greenhouse/contract';
import { conversations, getDb } from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';

async function setup() {
  const app = createTestApp();
  const lin = await app.member();
  const chen = await app.member();
  const room = (
    await app.call('POST', '/api/conversations', { token: lin.token, body: { kind: 'room', member_ids: [chen.id] } })
  ).body;
  const notes = `/api/conversations/${room.id}/notes`;
  return { ...app, lin, chen, room, notes };
}

describe('shared notes', () => {
  it('lets everyone in the conversation read and write them, keeping the author', async () => {
    const { call, services, lin, chen, room, notes } = await setup();
    const events: RealtimeEvent[] = [];
    services.hub.subscribe(chen.id, (event) => events.push(event));

    const created = await call('POST', notes, {
      token: lin.token,
      body: { title: 'Launch checklist', body: '- book the venue' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      conversation_id: room.id,
      title: 'Launch checklist',
      body: '- book the venue',
      status: 'open',
      pinned: false,
      author_member_id: lin.id,
      author_agent_id: null,
    });
    expect(events).toEqual([{ type: 'notes.updated', data: { conversation_id: room.id, note_id: created.body.id } }]);

    const changed = await call('PATCH', `${notes}/${created.body.id}`, {
      token: chen.token,
      body: { status: 'done', pinned: true, body: '- book the venue\n- send invites' },
    });
    expect(changed.body).toMatchObject({
      status: 'done',
      pinned: true,
      body: '- book the venue\n- send invites',
      title: 'Launch checklist',
      author_member_id: lin.id,
    });
    expect((await call('GET', notes, { token: chen.token })).body.items).toEqual([changed.body]);

    expect((await call('DELETE', `${notes}/${created.body.id}`, { token: chen.token })).status).toBe(204);
    expect((await call('DELETE', `${notes}/${created.body.id}`, { token: chen.token })).status).toBe(404);
    expect((await call('GET', notes, { token: lin.token })).body.items).toEqual([]);
    expect(events).toHaveLength(3);
  });

  it('keeps notes to the people of the conversation and checks what they hold', async () => {
    const { call, member, lin, room, notes } = await setup();
    const outsider = await member();
    const note = await call('POST', notes, { token: lin.token, body: { title: 'Private' } });
    expect((await call('GET', notes, { token: outsider.token })).status).toBe(404);
    expect((await call('POST', notes, { token: outsider.token, body: { title: 'x' } })).status).toBe(404);
    expect(
      (await call('PATCH', `${notes}/${note.body.id}`, { token: outsider.token, body: { title: 'y' } })).status,
    ).toBe(404);

    expect((await call('POST', notes, { token: lin.token, body: {} })).status).toBe(400);
    expect((await call('POST', notes, { token: lin.token, body: { body: 'x'.repeat(20_001) } })).status).toBe(400);
    expect((await call('POST', notes, { token: lin.token, body: { body: 'x'.repeat(20_000) } })).status).toBe(201);
    const emptied = await call('PATCH', `${notes}/${note.body.id}`, { token: lin.token, body: { title: '' } });
    expect(emptied.status).toBe(400);
    // A note of another conversation is not found through this one.
    const chat = await call('POST', '/api/conversations', { token: lin.token, body: { kind: 'chat' } });
    expect(
      (
        await call('PATCH', `/api/conversations/${chat.body.id}/notes/${note.body.id}`, {
          token: lin.token,
          body: { title: 'moved' },
        })
      ).status,
    ).toBe(404);

    await getDb().update(conversations).set({ readOnly: true }).where(eq(conversations.id, room.id));
    expect((await call('POST', notes, { token: lin.token, body: { title: 'late' } })).body.error.code).toBe(
      'read_only',
    );
    expect((await call('GET', notes, { token: lin.token })).status).toBe(200);
  });

  it('lists pinned notes first, then the newest, a page at a time', async () => {
    const { call, lin, notes } = await setup();
    const add = async (title: string, pinned = false) => {
      // Ids sort by their millisecond; within one they are random.
      await new Promise((resolve) => setTimeout(resolve, 3));
      return (await call('POST', notes, { token: lin.token, body: { title, pinned } })).body.id as string;
    };
    const oldest = await add('oldest');
    const pinned = await add('pinned', true);
    const middle = await add('middle');
    const newest = await add('newest');
    const first = await call('GET', `${notes}?limit=2`, { token: lin.token });
    expect(first.body.items.map((n: { id: string }) => n.id)).toEqual([pinned, newest]);
    const second = await call('GET', `${notes}?limit=2&cursor=${first.body.next_cursor}`, { token: lin.token });
    expect(second.body.items.map((n: { id: string }) => n.id)).toEqual([middle, oldest]);
    expect(second.body.next_cursor).toBeNull();
    expect((await call('GET', `${notes}?cursor=nonsense`, { token: lin.token })).status).toBe(400);
  });
});
