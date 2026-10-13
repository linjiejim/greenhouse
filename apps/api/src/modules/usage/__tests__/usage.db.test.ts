import { desc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditEvents, getDb, usageEvents } from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';

const ENV = { LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk-env-secret-0001' };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Event = Partial<typeof usageEvents.$inferInsert> & { at?: number };

async function record(event: Event) {
  const { at, ...values } = event;
  await getDb()
    .insert(usageEvents)
    .values({
      capability: 'llm',
      providerId: 'env-llm',
      source: 'env',
      ...values,
      createdAt: new Date(at ?? Date.now()).toISOString(),
    });
}

const startOfMonth = () => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
};

describe('usage', () => {
  it('shows me my own usage by capability, Agent and day, and only mine', async () => {
    const app = createTestApp(ENV);
    const lin = await app.member();
    const chen = await app.member();
    const main = (await app.call('GET', '/api/agents/main', { token: lin.token })).body;
    await record({
      memberId: lin.id,
      agentId: main.id,
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 40,
      costMicros: 500,
    });
    await record({ memberId: lin.id, agentId: main.id, inputTokens: 10, outputTokens: 5 });
    await record({
      memberId: lin.id,
      capability: 'search',
      providerId: 'env-search-tavily',
      quantity: 1,
      unit: 'request',
    });
    await record({ memberId: chen.id, inputTokens: 999, outputTokens: 999 });
    // Before this month and 30 days: counted by neither period.
    await record({ memberId: lin.id, inputTokens: 7, outputTokens: 7, at: Date.now() - 40 * DAY });
    // Just before this month began: in the last 30 days unless today is late on the 30th or 31st.
    const lastMonth = startOfMonth() - HOUR;
    await record({ memberId: lin.id, inputTokens: 1000, outputTokens: 0, at: lastMonth });

    const month = await app.call('GET', '/api/me/usage', { token: lin.token });
    expect(month.status).toBe(200);
    expect(month.body.period).toMatchObject({ name: 'month', start: new Date(startOfMonth()).toISOString() });
    expect(month.body.totals).toEqual({
      requests: 3,
      input_tokens: 110,
      output_tokens: 25,
      cached_tokens: 40,
      tokens: 135,
      cost_micros: 500,
      unpriced: 2,
    });
    expect(
      month.body.by_capability.map((row: { capability: string; requests: number }) => [row.capability, row.requests]),
    ).toEqual([
      ['llm', 2],
      ['search', 1],
    ]);
    expect(month.body.by_agent).toEqual([
      expect.objectContaining({ agent_id: main.id, name: 'Greeny', tokens: 135 }),
      expect.objectContaining({ agent_id: null, name: '', requests: 1 }),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    expect(month.body.by_day.at(-1)).toMatchObject({ day: today, tokens: 135 });
    expect(month.body.by_day[0].day).toBe(new Date(startOfMonth()).toISOString().slice(0, 10));
    expect(month.body.by_day).toHaveLength(new Date().getUTCDate());
    expect(month.body.budgets).toEqual([]);

    const rolling = await app.call('GET', '/api/me/usage?period=30d', { token: lin.token });
    const inWindow = Date.now() - lastMonth <= 30 * DAY;
    expect(rolling.body.totals.tokens).toBe(135 + (inWindow ? 1000 : 0));
    expect(rolling.body.by_day.length).toBeGreaterThanOrEqual(30);
    expect((await app.call('GET', '/api/me/usage?period=year', { token: lin.token })).status).toBe(400);
  });

  it('shows admins the workspace grouped four ways, and nobody else', async () => {
    const app = createTestApp(ENV);
    const admin = await app.member('admin');
    const lin = await app.member();
    const main = (await app.call('GET', '/api/agents/main', { token: lin.token })).body;
    await record({ memberId: lin.id, agentId: main.id, inputTokens: 100, outputTokens: 50 });
    await record({ memberId: admin.id, inputTokens: 10, outputTokens: 10 });
    await record({ memberId: lin.id, capability: 'search', providerId: 'env-search-tavily', quantity: 1 });

    expect((await app.call('GET', '/api/admin/usage', { token: lin.token })).status).toBe(403);
    const byMember = await app.call('GET', '/api/admin/usage', { token: admin.token });
    expect(byMember.body).toMatchObject({ group_by: 'member', totals: { requests: 3, tokens: 170 } });
    expect(
      byMember.body.groups.map((row: { key: string; label: string; detail: string; tokens: number }) => [
        row.key,
        row.label,
        row.detail,
        row.tokens,
      ]),
    ).toEqual([
      [lin.id, lin.name, lin.email, 150],
      [admin.id, admin.name, admin.email, 20],
    ]);
    const byAgent = await app.call('GET', '/api/admin/usage?group_by=agent', { token: admin.token });
    expect(byAgent.body.groups[0]).toMatchObject({ key: main.id, label: 'Greeny', detail: lin.name, tokens: 150 });
    const byProvider = await app.call('GET', '/api/admin/usage?group_by=provider', { token: admin.token });
    expect(byProvider.body.groups[0]).toMatchObject({ key: 'env-llm', detail: 'llm', tokens: 170 });
    const byCapability = await app.call('GET', '/api/admin/usage?group_by=capability', { token: admin.token });
    expect(byCapability.body.groups.map((row: { key: string }) => row.key)).toEqual(['llm', 'search']);
  });
});

describe('budgets', () => {
  it('are set per workspace, provider and member, and show what they spent this month', async () => {
    const app = createTestApp(ENV);
    const admin = await app.member('admin');
    const lin = await app.member();
    await record({ memberId: lin.id, inputTokens: 300, outputTokens: 100, costMicros: 2_000 });
    await record({ memberId: lin.id, inputTokens: 50, outputTokens: 50, at: Date.now() - 40 * DAY });
    // A member's own key is not the workspace's money unless the policy says so.
    await record({ memberId: lin.id, inputTokens: 1000, outputTokens: 0, providerId: 'lins-key', source: 'personal' });

    expect((await app.call('PUT', '/api/admin/budgets', { token: lin.token, body: {} })).status).toBe(403);
    const workspace = await app.call('PUT', '/api/admin/budgets', {
      token: admin.token,
      body: { scope_type: 'workspace', unit: 'tokens', monthly_limit: 1000 },
    });
    expect(workspace.status).toBe(200);
    expect(workspace.body).toMatchObject({
      scope_type: 'workspace',
      scope_id: 'default',
      unit: 'tokens',
      monthly_limit: 1000,
      enabled: true,
      spent: 400,
      exceeded: false,
    });
    const member = await app.call('PUT', '/api/admin/budgets', {
      token: admin.token,
      body: { scope_type: 'member', scope_id: lin.id, unit: 'usd_micros', monthly_limit: 1_500 },
    });
    expect(member.body).toMatchObject({ scope_name: lin.name, spent: 2_000, exceeded: true });
    const provider = await app.call('PUT', '/api/admin/budgets', {
      token: admin.token,
      body: { scope_type: 'provider', scope_id: 'env-llm', unit: 'tokens', monthly_limit: 10_000 },
    });
    expect(provider.body).toMatchObject({ scope_name: expect.any(String), spent: 400 });

    // Saving the same scope and unit again replaces its limit.
    const raised = await app.call('PUT', '/api/admin/budgets', {
      token: admin.token,
      body: { scope_type: 'member', scope_id: lin.id, unit: 'usd_micros', monthly_limit: 5_000 },
    });
    expect(raised.body).toMatchObject({ id: member.body.id, monthly_limit: 5_000, exceeded: false });

    const list = await app.call('GET', '/api/admin/budgets', { token: admin.token });
    expect(list.body.items.map((budget: { scope_type: string }) => budget.scope_type).sort()).toEqual([
      'member',
      'provider',
      'workspace',
    ]);
    expect(list.body.next_cursor).toBeNull();
    // The member sees their own budget with their usage.
    expect((await app.call('GET', '/api/me/usage', { token: lin.token })).body.budgets).toEqual([
      { unit: 'usd_micros', monthly_limit: 5_000, spent: 2_000 },
    ]);

    // When the policy counts personal keys, the workspace budget counts them too.
    await app.call('PUT', '/api/admin/provider-bindings/llm', {
      token: admin.token,
      body: { instance_ids: ['env-llm'], policy: { allow_personal: true, personal_counts_toward_budget: true } },
    });
    const counted = await app.call('GET', '/api/admin/budgets', { token: admin.token });
    expect(
      counted.body.items.find((budget: { scope_type: string }) => budget.scope_type === 'workspace'),
    ).toMatchObject({
      spent: 1400,
      exceeded: true,
    });

    const [record_] = await getDb().select().from(auditEvents).orderBy(desc(auditEvents.id)).limit(1);
    expect(record_).toMatchObject({ action: 'provider.binding' });
    const saves = await getDb().select().from(auditEvents).where(eq(auditEvents.action, 'budget.save'));
    expect(saves).toHaveLength(4);
    expect(saves.every((entry) => !entry.summary.includes('5000') && !entry.summary.includes('1000'))).toBe(true);

    expect((await app.call('DELETE', `/api/admin/budgets/${provider.body.id}`, { token: admin.token })).status).toBe(
      204,
    );
    expect((await app.call('DELETE', `/api/admin/budgets/${provider.body.id}`, { token: admin.token })).status).toBe(
      404,
    );
    expect((await getDb().select().from(auditEvents).where(eq(auditEvents.action, 'budget.delete'))).length).toBe(1);
  });

  it('refuse scopes that do not exist or are not the workspace’s to budget', async () => {
    const app = createTestApp(ENV);
    const admin = await app.member('admin');
    const put = (body: unknown) => app.call('PUT', '/api/admin/budgets', { token: admin.token, body });
    expect((await put({ scope_type: 'member', scope_id: 'mbr_nobody', unit: 'tokens', monthly_limit: 1 })).status).toBe(
      400,
    );
    expect((await put({ scope_type: 'provider', scope_id: 'nope', unit: 'tokens', monthly_limit: 1 })).status).toBe(
      400,
    );
    expect((await put({ scope_type: 'workspace', scope_id: 'x', unit: 'tokens', monthly_limit: 1 })).status).toBe(400);
    expect((await put({ scope_type: 'member', unit: 'tokens', monthly_limit: 1 })).status).toBe(400);
    expect((await put({ scope_type: 'workspace', unit: 'tokens', monthly_limit: 0 })).status).toBe(400);
  });
});
