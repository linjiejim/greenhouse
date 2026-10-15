import { generateText } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, getDb, usageEvents } from '@greenhouse/db';
import { createTestApp } from '../../testing.js';

it('lets only the owner or admin budget a published Agent and audits each change', async () => {
  const app = createTestApp();
  const owner = await app.member();
  const other = await app.member();
  const admin = await app.member('admin');
  const agent = (await app.call('POST', '/api/agents', { token: owner.token, body: { name: 'Researcher' } })).body;
  const path = `/api/agents/${agent.id}/budgets`;
  const body = { unit: 'tokens', monthly_limit: 100 };
  expect((await app.call('PUT', path, { token: owner.token, body })).status).toBe(400);
  await app.call('PUT', `/api/agents/${agent.id}/publication`, {
    token: owner.token,
    body: { audience: [{ type: 'workspace' }] },
  });
  expect((await app.call('PUT', path, { token: other.token, body })).status).toBe(403);
  expect((await app.call('GET', path, { token: other.token })).status).toBe(403);
  const saved = await app.call('PUT', path, { token: owner.token, body });
  expect(saved.status).toBe(200);
  expect(saved.body).toMatchObject({ scope_type: 'agent', scope_id: agent.id, spent: 0, monthly_limit: 100 });
  const updated = await app.call('PUT', '/api/admin/budgets', {
    token: admin.token,
    body: { ...body, scope_type: 'agent', scope_id: agent.id, monthly_limit: 200 },
  });
  expect(updated.body.id).toBe(saved.body.id);
  expect((await app.call('GET', path, { token: owner.token })).body.items[0].monthly_limit).toBe(200);
  expect(
    (await app.call('GET', `/api/agents/${agent.id}/usage`, { token: owner.token })).body.budgets[0].monthly_limit,
  ).toBe(200);
  const audits = await getDb().select().from(auditEvents).where(eq(auditEvents.resourceId, saved.body.id));
  expect(audits.map((row) => row.actorId)).toEqual([owner.id, admin.id]);
});

describe('Agent budgets at the provider boundary', () => {
  it('aggregates all members and refuses a call before network access; older months and other Agents do not count', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'completion',
            object: 'chat.completion',
            created: 1,
            model: 'm',
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    const app = createTestApp(
      { LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk-test-0001' },
      { fetch: fetch as typeof globalThis.fetch },
    );
    const owner = await app.member();
    const other = await app.member();
    const agent = (await app.call('POST', '/api/agents', { token: owner.token, body: { name: 'Researcher' } })).body;
    await app.call('PUT', `/api/agents/${agent.id}/publication`, {
      token: owner.token,
      body: { audience: [{ type: 'workspace' }] },
    });
    await app.call('PUT', `/api/agents/${agent.id}/budgets`, {
      token: owner.token,
      body: { unit: 'tokens', monthly_limit: 10 },
    });
    const now = new Date();
    await getDb()
      .insert(usageEvents)
      .values({
        capability: 'llm',
        providerId: 'env-llm',
        source: 'env',
        agentId: agent.id,
        inputTokens: 1000,
        createdAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString(),
      });
    const call = async (memberId: string) =>
      generateText({
        model: (await app.services.providers.languageModel('default', { memberId, agentId: agent.id })).model,
        prompt: 'hi',
        maxRetries: 0,
      });
    await call(owner.id);
    await call(other.id);
    await expect(call(owner.id)).rejects.toMatchObject({ code: 'budget_exceeded', details: { scope_type: 'agent' } });
    expect(fetch).toHaveBeenCalledTimes(2);
    await generateText({
      model: (await app.services.providers.languageModel('default', { memberId: owner.id })).model,
      prompt: 'hi',
      maxRetries: 0,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
