import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing.js';

describe('agents', () => {
  it('gives every member a main Agent, Greeny, in their language', async () => {
    const { call, member } = createTestApp();
    const lin = await member();
    const list = await call('GET', '/api/agents', { token: lin.token });
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([
      expect.objectContaining({
        handle: 'main',
        name: 'Greeny',
        role: '主助手',
        is_main: true,
        avatar: { plant: 'sprout' },
      }),
    ]);
    // Idempotent, and `main` works as an id.
    expect((await call('GET', '/api/agents', { token: lin.token })).body.items).toHaveLength(1);
    const main = await call('GET', '/api/agents/main', { token: lin.token });
    expect(main.body).toMatchObject({ id: list.body.items[0].id, model: 'default', write: true, current_version: 1 });
    expect(main.body.instructions).toContain('主 Agent');
  });

  it('creates Agents from a template or blank, with unique names', async () => {
    const { call, member } = createTestApp();
    const lin = await member();
    const researcher = await call('POST', '/api/agents', { token: lin.token, body: { template_key: 'researcher' } });
    expect(researcher.status).toBe(201);
    expect(researcher.body).toMatchObject({
      name: '蒲蒲',
      role: '研究员',
      template_key: 'researcher',
      avatar: { plant: 'dandelion' },
      handle: `agent:${researcher.body.id}`,
      conversation_id: null,
    });

    const blank = await call('POST', '/api/agents', {
      token: lin.token,
      body: { name: 'Scout', avatar: { plant: 'not-a-plant', tint: 'rose' } },
    });
    expect(blank.status).toBe(201);
    expect(blank.body.avatar.tint).toBe('rose');
    expect(['sprout', 'dandelion']).not.toContain(blank.body.avatar.plant);

    const taken = await call('POST', '/api/agents', { token: lin.token, body: { name: ' scout ' } });
    expect(taken.body.error.code).toBe('agent_name_taken');
    expect((await call('POST', '/api/agents', { token: lin.token, body: { name: 'System' } })).status).toBe(400);
    expect((await call('POST', '/api/agents', { token: lin.token, body: { template_key: 'main' } })).status).toBe(400);
    expect((await call('POST', '/api/agents', { token: lin.token, body: {} })).status).toBe(400);
    expect((await call('POST', '/api/agents', { token: lin.token, body: { name: 'X', model: 'nope/m' } })).status).toBe(
      400,
    );
    expect((await call('POST', '/api/agents', { token: lin.token, body: { name: 'Y', model: 'strong' } })).status).toBe(
      201,
    );
  });

  it('appends a version on every change and keeps old versions readable', async () => {
    const { call, member, services } = createTestApp();
    const lin = await member();
    const created = await call('POST', '/api/agents', { token: lin.token, body: { template_key: 'writer' } });
    const id = created.body.id;
    const updated = await call('PATCH', `/api/agents/${id}`, {
      token: lin.token,
      body: { instructions: 'Write like Hemingway.', change_note: 'tighter' },
    });
    expect(updated.body).toMatchObject({ current_version: 2, instructions: 'Write like Hemingway.' });
    // An unchanged save appends nothing.
    expect(
      (await call('PATCH', `/api/agents/${id}`, { token: lin.token, body: { instructions: 'Write like Hemingway.' } }))
        .body.current_version,
    ).toBe(2);
    const versions = await call('GET', `/api/agents/${id}/versions`, { token: lin.token });
    expect(
      versions.body.items.map((v: { version: number; change_note: string }) => [v.version, v.change_note]),
    ).toEqual([
      [2, 'tighter'],
      [1, ''],
    ]);
    const pinned = await services.agents.load(lin.id, `agent:${id}@1`);
    expect(pinned.version).toBe(1);
    expect(pinned.manifest.instructions).not.toBe('Write like Hemingway.');
  });

  it('archives and restores, but never the main Agent, and only for the owner', async () => {
    const { call, member } = createTestApp();
    const lin = await member();
    const chen = await member();
    const created = await call('POST', '/api/agents', { token: lin.token, body: { name: 'Temp' } });
    const id = created.body.id;
    expect((await call('GET', `/api/agents/${id}`, { token: chen.token })).status).toBe(404);
    expect((await call('DELETE', `/api/agents/${id}`, { token: chen.token })).status).toBe(404);

    const protectedMain = await call('DELETE', '/api/agents/main', { token: lin.token });
    expect(protectedMain.body.error.code).toBe('agent_protected');

    expect((await call('DELETE', `/api/agents/${id}`, { token: lin.token })).status).toBe(204);
    const mine = await call('GET', '/api/agents', { token: lin.token });
    expect(mine.body.items.map((agent: { id: string }) => agent.id)).not.toContain(id);
    const archived = await call('GET', '/api/agents?scope=archived', { token: lin.token });
    expect(archived.body.items.map((agent: { id: string }) => agent.id)).toEqual([id]);
    expect((await call('PATCH', `/api/agents/${id}`, { token: lin.token, body: { role: 'x' } })).body.error.code).toBe(
      'agent_archived',
    );
    // A new Agent can take the archived one's name; restoring then clashes.
    await call('POST', '/api/agents', { token: lin.token, body: { name: 'Temp' } });
    expect((await call('POST', `/api/agents/${id}/restore`, { token: lin.token })).body.error.code).toBe(
      'agent_name_taken',
    );
  });

  it('keeps memories per Agent and member, and forgets them for good', async () => {
    const { call, member } = createTestApp();
    const lin = await member();
    const chen = await member();
    const saved = await call('POST', '/api/agents/main/memories', {
      token: lin.token,
      body: { title: 'Prefers short answers', category: 'preference', pinned: true },
    });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ title: 'Prefers short answers', pinned: true, source: 'member' });
    const listed = await call('GET', '/api/agents/main/memories', { token: lin.token });
    expect(listed.body.items).toHaveLength(1);
    expect((await call('GET', '/api/agents/main/memories', { token: chen.token })).body.items).toHaveLength(0);
    const edited = await call('PATCH', `/api/agents/main/memories/${saved.body.id}`, {
      token: lin.token,
      body: { content: 'One paragraph at most.' },
    });
    expect(edited.body.content).toBe('One paragraph at most.');
    expect((await call('DELETE', `/api/agents/main/memories/${saved.body.id}`, { token: chen.token })).status).toBe(
      404,
    );
    expect((await call('DELETE', `/api/agents/main/memories/${saved.body.id}`, { token: lin.token })).status).toBe(204);
    expect((await call('GET', '/api/agents/main/memories?status=all', { token: lin.token })).body.items).toHaveLength(
      0,
    );
  });
});
