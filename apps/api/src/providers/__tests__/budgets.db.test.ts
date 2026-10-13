import { generateText } from 'ai';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { getDb, messages, runs, usageEvents } from '@greenhouse/db';
import { createTestApp } from '../../testing.js';

const ENV_KEY = 'sk-env-secret-0001';
const ENV = { LLM_PROVIDER: 'deepseek', LLM_API_KEY: ENV_KEY };

/** Every completion uses 7 input and 2 output tokens. */
function network() {
  const calls: URL[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url));
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const corpQwen = {
  capability: 'llm',
  kind: 'openai-compatible',
  preset: 'qwen',
  name: 'Corp Qwen',
  config: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    // Dollars per million tokens: 7 input tokens cost 14 micro-dollars, 2 output tokens 12.
    models: [{ id: 'qwen-plus', price: { input: 2, output: 6 } }],
  },
  secrets: { apiKey: 'sk-qwen-secret-0002' },
};

describe('budgets at call time', () => {
  it('record the cost of a priced model and refuse calls once a member budget is used up', async () => {
    const net = network();
    const app = createTestApp(ENV, { fetch: net.fetch });
    const admin = await app.member('admin');
    const lin = await app.member();
    const created = await app.call('POST', '/api/admin/providers', { token: admin.token, body: corpQwen });
    expect(created.status).toBe(201);

    const qwen = async () =>
      generateText({
        model: (await app.services.providers.languageModel(`${created.body.id}/qwen-plus`, { memberId: lin.id })).model,
        prompt: 'hi',
        maxRetries: 0,
      });
    await qwen();
    const [usage] = await getDb().select().from(usageEvents).where(eq(usageEvents.memberId, lin.id));
    expect(usage).toMatchObject({ model: 'qwen-plus', inputTokens: 7, outputTokens: 2, costMicros: 26 });

    // An unpriced model has no known cost.
    await generateText({
      model: (await app.services.providers.languageModel('env-llm/deepseek-chat', { memberId: admin.id })).model,
      prompt: 'hi',
    });
    const [unpriced] = await getDb().select().from(usageEvents).where(eq(usageEvents.memberId, admin.id));
    expect(unpriced!.costMicros).toBeNull();

    await app.call('PUT', '/api/admin/budgets', {
      token: admin.token,
      body: { scope_type: 'member', scope_id: lin.id, unit: 'usd_micros', monthly_limit: 26 },
    });
    await expect(qwen()).rejects.toMatchObject({ code: 'budget_exceeded', status: 429 });
    // Others are not affected; raising the limit lets lin go on.
    await generateText({
      model: (await app.services.providers.languageModel('default', { memberId: admin.id })).model,
      prompt: 'hi',
    });
    await app.call('PUT', '/api/admin/budgets', {
      token: admin.token,
      body: { scope_type: 'member', scope_id: lin.id, unit: 'usd_micros', monthly_limit: 1_000 },
    });
    await qwen();
  });

  it('move on to the next instance when one instance is over its own budget', async () => {
    const net = network();
    const app = createTestApp(ENV, { fetch: net.fetch });
    const admin = await app.member('admin');
    await app.call('POST', '/api/admin/providers', { token: admin.token, body: corpQwen });
    await app.call('PUT', '/api/admin/budgets', {
      token: admin.token,
      body: { scope_type: 'provider', scope_id: 'env-llm', unit: 'tokens', monthly_limit: 5 },
    });
    const call = async () =>
      generateText({
        model: (await app.services.providers.languageModel('default', { memberId: admin.id })).model,
        prompt: 'hi',
        maxRetries: 0,
      });
    await call();
    await call();
    // The first call spent 9 tokens on DeepSeek; the second went to Qwen without reaching DeepSeek.
    expect(net.calls.map((url) => url.origin)).toEqual(['https://api.deepseek.com', 'https://dashscope.aliyuncs.com']);
  });

  it('end a turn with their own message once the member’s budget is used up', async () => {
    const net = network();
    const app = createTestApp(ENV, { fetch: net.fetch });
    const admin = await app.member('admin');
    const lin = await app.member();
    await getDb()
      .insert(usageEvents)
      .values({ capability: 'llm', providerId: 'env-llm', source: 'env', memberId: lin.id, inputTokens: 10 });
    await app.call('PUT', '/api/admin/budgets', {
      token: admin.token,
      body: { scope_type: 'member', scope_id: lin.id, unit: 'tokens', monthly_limit: 10 },
    });
    const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
    const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'hi' },
    });
    await app.services.engine.idle();
    const [run] = await getDb().select().from(runs).where(eq(runs.id, sent.body.run_id));
    expect(run).toMatchObject({ status: 'failed', errorCode: 'budget_exceeded' });
    const [reply] = await getDb().select().from(messages).where(eq(messages.runId, sent.body.run_id));
    expect(reply).toMatchObject({ status: 'failed', content: '本月的用量预算已经用完了，请联系管理员。' });
    // Refused before anything left for the vendor.
    expect(net.calls).toEqual([]);
  });

  it('leave a member’s own key out of the workspace budget unless the policy counts it', async () => {
    const net = network();
    const app = createTestApp(ENV, { fetch: net.fetch });
    const admin = await app.member('admin');
    const lin = await app.member();
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
    expect(own.status).toBe(201);
    await app.call('PUT', '/api/admin/budgets', {
      token: admin.token,
      body: { scope_type: 'workspace', unit: 'tokens', monthly_limit: 5 },
    });
    const call = async (memberId: string) =>
      generateText({
        model: (await app.services.providers.languageModel('default', { memberId })).model,
        prompt: 'hi',
        maxRetries: 0,
      });
    await call(admin.id);
    await expect(call(admin.id)).rejects.toMatchObject({ code: 'budget_exceeded' });
    // Lin's own key is lin's money.
    await call(lin.id);
    await app.call('PUT', '/api/admin/provider-bindings/llm', {
      token: admin.token,
      body: { instance_ids: ['env-llm'], policy: { allow_personal: true, personal_counts_toward_budget: true } },
    });
    await expect(call(lin.id)).rejects.toMatchObject({ code: 'budget_exceeded' });
  });
});
