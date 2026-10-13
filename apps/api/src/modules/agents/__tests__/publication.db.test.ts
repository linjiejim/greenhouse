import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditEvents, getDb, members, shares } from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';

async function setup() {
  const app = createTestApp();
  const lin = await app.member();
  const chen = await app.member();
  const wu = await app.member();
  const created = await app.call('POST', '/api/agents', {
    token: lin.token,
    body: { name: 'Helper', role: 'Researcher', instructions: 'Published instructions.' },
  });
  return { ...app, lin, chen, wu, agentId: created.body.id as string };
}

const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe('publishing an Agent', () => {
  it('publishes a pinned version to an audience, lists it for them and marks it public for its owner', async () => {
    const { call, lin, chen, wu, agentId } = await setup();
    const published = await call('PUT', `/api/agents/${agentId}/publication`, {
      token: lin.token,
      body: { audience: [{ type: 'member', id: chen.id }], daily_cap: 5 },
    });
    expect(published.status).toBe(200);
    expect(published.body).toEqual({
      agent_id: agentId,
      published: true,
      version: 1,
      current_version: 1,
      audience: [{ type: 'member', id: chen.id, name: chen.name }],
      computer: false,
      daily_cap: 5,
      paused_at: null,
    });
    const mine = await call('GET', '/api/agents', { token: lin.token });
    expect(mine.body.items.find((agent: { id: string }) => agent.id === agentId)).toMatchObject({
      visibility: 'public',
      published_version: 1,
      paused_at: null,
      owner_id: lin.id,
    });

    // The owner keeps editing; the audience sees the published version until it is republished.
    await call('PATCH', `/api/agents/${agentId}`, { token: lin.token, body: { name: 'Helper Two', role: 'Writer' } });
    const shared = await call('GET', '/api/agents?scope=public', { token: chen.token });
    expect(shared.body.items).toEqual([
      expect.objectContaining({
        id: agentId,
        name: 'Helper',
        role: 'Researcher',
        current_version: 1,
        published_version: 1,
        visibility: 'public',
        last_active_at: null,
        daily_cap: 5,
        owner: expect.objectContaining({ id: lin.id, name: lin.name }),
      }),
    ]);
    // Not shared with wu; never in its owner's public list.
    expect((await call('GET', '/api/agents?scope=public', { token: wu.token })).body.items).toEqual([]);
    expect((await call('GET', '/api/agents?scope=public', { token: lin.token })).body.items).toEqual([]);

    // Republishing moves the pin and replaces the audience.
    const republished = await call('PUT', `/api/agents/${agentId}/publication`, {
      token: lin.token,
      body: { version: 2, audience: [{ type: 'workspace' }], computer: true },
    });
    expect(republished.body).toMatchObject({ version: 2, current_version: 2, computer: true, daily_cap: 0 });
    expect(republished.body.audience).toEqual([{ type: 'workspace', id: null, name: 'Greenhouse' }]);
    expect((await call('GET', '/api/agents?scope=public', { token: wu.token })).body.items[0]).toMatchObject({
      id: agentId,
      name: 'Helper Two',
    });
    const grants = await getDb()
      .select()
      .from(shares)
      .where(and(eq(shares.resourceType, 'agent'), eq(shares.resourceId, agentId)));
    expect(grants).toEqual([expect.objectContaining({ principalType: 'workspace', principalId: null, role: 'user' })]);
    const actions = (await getDb().select().from(auditEvents).where(eq(auditEvents.resourceId, agentId))).map(
      (entry) => entry.action,
    );
    expect(actions).toEqual(['agent.publish', 'agent.republish']);

    // Unpublishing takes it away from everyone; the grants go with it.
    expect((await call('DELETE', `/api/agents/${agentId}/publication`, { token: lin.token })).status).toBe(204);
    expect((await call('GET', '/api/agents?scope=public', { token: wu.token })).body.items).toEqual([]);
    expect((await call('GET', `/api/agents/${agentId}/publication`, { token: lin.token })).body).toMatchObject({
      published: false,
      version: null,
      audience: [],
    });
    expect(
      await getDb()
        .select()
        .from(shares)
        .where(and(eq(shares.resourceType, 'agent'), eq(shares.resourceId, agentId))),
    ).toEqual([]);
  });

  it('reaches a group, and leaves out paused, archived and departed owners’ Agents', async () => {
    const { call, member, lin, chen, wu, agentId } = await setup();
    const admin = await member('admin');
    const group = await call('POST', '/api/admin/groups', {
      token: admin.token,
      body: { name: 'Research', member_ids: [chen.id] },
    });
    await call('PUT', `/api/agents/${agentId}/publication`, {
      token: lin.token,
      body: { audience: [{ type: 'group', id: group.body.id }] },
    });
    expect(ids((await call('GET', '/api/agents?scope=public', { token: chen.token })).body.items)).toEqual([agentId]);
    expect((await call('GET', '/api/agents?scope=public', { token: wu.token })).body.items).toEqual([]);

    await call('POST', `/api/admin/public-agents/${agentId}/pause`, { token: admin.token });
    expect((await call('GET', '/api/agents?scope=public', { token: chen.token })).body.items).toEqual([]);
    await call('POST', `/api/admin/public-agents/${agentId}/resume`, { token: admin.token });
    expect(ids((await call('GET', '/api/agents?scope=public', { token: chen.token })).body.items)).toEqual([agentId]);

    await call('DELETE', `/api/agents/${agentId}`, { token: lin.token });
    expect((await call('GET', '/api/agents?scope=public', { token: chen.token })).body.items).toEqual([]);
    await call('POST', `/api/agents/${agentId}/restore`, { token: lin.token });
    expect(ids((await call('GET', '/api/agents?scope=public', { token: chen.token })).body.items)).toEqual([agentId]);

    await getDb().update(members).set({ status: 'disabled' }).where(eq(members.id, lin.id));
    expect((await call('GET', '/api/agents?scope=public', { token: chen.token })).body.items).toEqual([]);
  });

  it('never publishes the main Agent, an archived one, a missing version or an invalid audience', async () => {
    const { call, lin, chen, agentId } = await setup();
    const put = (id: string, body: unknown) => call('PUT', `/api/agents/${id}/publication`, { token: lin.token, body });
    const audience = [{ type: 'member', id: chen.id }];
    expect((await put('main', { audience })).body.error.code).toBe('agent_protected');
    expect((await put(agentId, { version: 9, audience })).status).toBe(404);
    expect((await put(agentId, { audience: [] })).status).toBe(400);
    expect((await put(agentId, { audience: [{ type: 'member' }] })).status).toBe(400);
    expect((await put(agentId, { audience: [{ type: 'workspace', id: 'x' }] })).status).toBe(400);
    expect((await put(agentId, { audience: [{ type: 'member', id: 'mbr_nobody' }] })).status).toBe(400);
    expect((await put(agentId, { audience: [{ type: 'group', id: 'grp_nobody' }] })).status).toBe(400);
    // Only its owner is no audience.
    expect((await put(agentId, { audience: [{ type: 'member', id: lin.id }] })).status).toBe(400);
    expect((await put(agentId, { audience, daily_cap: -1 })).status).toBe(400);
    // Someone else's Agent is not found.
    expect(
      (await call('PUT', `/api/agents/${agentId}/publication`, { token: chen.token, body: { audience } })).status,
    ).toBe(404);
    await call('DELETE', `/api/agents/${agentId}`, { token: lin.token });
    expect((await put(agentId, { audience })).body.error.code).toBe('agent_archived');
  });

  it('refuses a version that runs on a model only its owner’s own key reaches', async () => {
    const app = createTestApp({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk-env-0001' });
    const admin = await app.member('admin');
    const lin = await app.member();
    const chen = await app.member();
    await app.call('PUT', '/api/admin/provider-bindings/llm', {
      token: admin.token,
      body: { instance_ids: ['env-llm'], policy: { allow_personal: true } },
    });
    const own = await app.call('POST', '/api/me/providers', {
      token: lin.token,
      body: {
        capability: 'llm',
        kind: 'openai-compatible',
        preset: 'deepseek',
        name: 'My DeepSeek',
        config: { baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' },
        secrets: { apiKey: 'sk-lin-own-0003' },
      },
    });
    const agent = await app.call('POST', '/api/agents', {
      token: lin.token,
      body: { name: 'Mine', model: `${own.body.id}/deepseek-chat` },
    });
    expect(agent.status).toBe(201);
    const refused = await app.call('PUT', `/api/agents/${agent.body.id}/publication`, {
      token: lin.token,
      body: { audience: [{ type: 'member', id: chen.id }] },
    });
    expect(refused.body.error.code).toBe('model_not_shareable');
    await app.call('PATCH', `/api/agents/${agent.body.id}`, { token: lin.token, body: { model: 'default' } });
    expect(
      (
        await app.call('PUT', `/api/agents/${agent.body.id}/publication`, {
          token: lin.token,
          body: { audience: [{ type: 'member', id: chen.id }] },
        })
      ).body.version,
    ).toBe(2);
  });
});

describe('public Agents for admins', () => {
  it('lists every public Agent with its owner and audience, and pauses and resumes it, audited', async () => {
    const { call, member, lin, chen, wu, agentId } = await setup();
    const admin = await member('admin');
    expect((await call('GET', '/api/admin/public-agents', { token: lin.token })).status).toBe(403);
    expect((await call('GET', '/api/admin/public-agents', { token: admin.token })).body.items).toEqual([]);
    await call('PUT', `/api/agents/${agentId}/publication`, {
      token: lin.token,
      body: {
        audience: [
          { type: 'member', id: chen.id },
          { type: 'member', id: wu.id },
        ],
      },
    });
    const list = await call('GET', '/api/admin/public-agents', { token: admin.token });
    expect(list.body).toEqual({
      items: [
        expect.objectContaining({
          id: agentId,
          name: 'Helper',
          published_version: 1,
          paused_at: null,
          audience_size: 2,
          owner: expect.objectContaining({ id: lin.id }),
          month: expect.objectContaining({ turns: 0, people: 0, requests: 0, tokens: 0 }),
        }),
      ],
      next_cursor: null,
    });

    const paused = await call('POST', `/api/admin/public-agents/${agentId}/pause`, { token: admin.token });
    expect(paused.body.paused_at).not.toBeNull();
    // Pausing twice changes nothing and records nothing more.
    await call('POST', `/api/admin/public-agents/${agentId}/pause`, { token: admin.token });
    expect((await call('GET', '/api/agents', { token: lin.token })).body.items[1].paused_at).not.toBeNull();
    const resumed = await call('POST', `/api/admin/public-agents/${agentId}/resume`, { token: admin.token });
    expect(resumed.body.paused_at).toBeNull();
    const actions = (await getDb().select().from(auditEvents).where(eq(auditEvents.resourceId, agentId)))
      .filter((entry) => entry.actorId === admin.id)
      .map((entry) => entry.action);
    expect(actions).toEqual(['agent.pause', 'agent.resume']);

    // Only public Agents: a private one is not found.
    const main = (await call('GET', '/api/agents/main', { token: lin.token })).body;
    expect((await call('POST', `/api/admin/public-agents/${main.id}/pause`, { token: admin.token })).status).toBe(404);
  });
});
