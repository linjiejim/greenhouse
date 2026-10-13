import { generateText } from 'ai';
import { desc, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { auditEvents, getDb, providers, usageEvents } from '@greenhouse/db';
import { createTestApp } from '../../testing.js';

const ENV_KEY = 'sk-env-secret-0001';
const ENV = { LLM_PROVIDER: 'deepseek', LLM_API_KEY: ENV_KEY, LLM_MODEL_STRONG: 'deepseek-reasoner' };

const completion = (model: string) =>
  new Response(
    JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );

/** A fake network: answers chat completions and records where each request went and with which key. */
function network(answer: (url: URL) => Response | Promise<Response> = () => completion('m')) {
  const calls: { url: URL; authorization: string | null; model?: string }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { model?: string }) : {};
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization'), model: body.model });
    return answer(url);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function setup(env: Record<string, string> = ENV) {
  const net = network();
  return { ...createTestApp(env, { fetch: net.fetch }), net };
}

const corpQwen = {
  capability: 'llm',
  kind: 'openai-compatible',
  preset: 'qwen',
  name: 'Corp Qwen',
  config: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    models: [{ id: 'qwen-max' }],
  },
  secrets: { apiKey: 'sk-qwen-secret-0002' },
};

describe('providers', () => {
  it('lists env instances read-only and never returns a key', async () => {
    const { call, member } = setup();
    const admin = await member('admin');
    const view = await call('GET', '/api/admin/providers', { token: admin.token });
    expect(view.status).toBe(200);
    const llm = view.body.capabilities.find((entry: { capability: string }) => entry.capability === 'llm');
    expect(llm).toMatchObject({ order: ['env-llm'], effective: ['env-llm'], bound: false });
    expect(llm.instances[0]).toMatchObject({ id: 'env-llm', source: 'env', editable: false, secrets_set: ['apiKey'] });
    const storage = view.body.capabilities.find((entry: { capability: string }) => entry.capability === 'storage');
    expect(storage.effective).toEqual(['builtin-storage']);
    expect(view.body.catalog.some((adapter: { kind: string }) => adapter.kind === 'openai-compatible')).toBe(true);
    expect(JSON.stringify(view.body)).not.toContain(ENV_KEY);

    expect(
      (await call('PATCH', '/api/admin/providers/env-llm', { token: admin.token, body: { name: 'x' } })).status,
    ).toBe(403);
    expect((await call('GET', '/api/admin/providers', { token: (await member()).token })).status).toBe(403);
  });

  it('seals keys, audits changes and keeps env first until an order is saved', async () => {
    const { call, member, services, net } = setup();
    const admin = await member('admin');
    const created = await call('POST', '/api/admin/providers', { token: admin.token, body: corpQwen });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: 'corp-qwen',
      source: 'workspace',
      editable: true,
      secrets_set: ['apiKey'],
    });
    expect(JSON.stringify(created.body)).not.toContain('sk-qwen');

    const [row] = await getDb().select().from(providers).where(eq(providers.id, 'corp-qwen'));
    expect(row!.secretsEnc).toMatch(/^k1:/);
    expect(row!.secretsEnc).not.toContain('sk-qwen');
    const [record] = await getDb().select().from(auditEvents).orderBy(desc(auditEvents.id)).limit(1);
    expect(record).toMatchObject({ action: 'provider.create', resourceId: 'corp-qwen', actorId: admin.id });
    expect(record!.summary).not.toContain('sk-qwen');

    await generateText({
      model: await services.providers.languageModel('default', { memberId: admin.id }),
      prompt: 'hi',
    });
    expect(net.calls.at(-1)!.url.origin).toBe('https://api.deepseek.com');
    expect(net.calls.at(-1)!.authorization).toBe(`Bearer ${ENV_KEY}`);

    const bound = await call('PUT', '/api/admin/provider-bindings/llm', {
      token: admin.token,
      body: { instance_ids: ['corp-qwen'], defaults: { default: 'corp-qwen/qwen-max' } },
    });
    expect(bound.body).toMatchObject({ order: ['corp-qwen'], effective: ['corp-qwen'], bound: true });
    await generateText({
      model: await services.providers.languageModel('default', { memberId: admin.id }),
      prompt: 'hi',
    });
    expect(net.calls.at(-1)).toMatchObject({ authorization: 'Bearer sk-qwen-secret-0002', model: 'qwen-max' });
    expect(net.calls.at(-1)!.url.origin).toBe('https://dashscope.aliyuncs.com');
    // strong has no default of its own: it follows default.
    await generateText({
      model: await services.providers.languageModel('strong', { memberId: admin.id }),
      prompt: 'hi',
    });
    expect(net.calls.at(-1)!.model).toBe('qwen-max');

    const off = await call('PUT', '/api/admin/provider-bindings/llm', {
      token: admin.token,
      body: { instance_ids: [] },
    });
    expect(off.body.effective).toEqual([]);
    await expect(services.providers.languageModel('default', { memberId: admin.id })).rejects.toMatchObject({
      code: 'llm_not_configured',
    });
  });

  it('records usage for every model call and refuses models an instance does not list', async () => {
    const { member, services } = setup();
    const lin = await member();
    const model = await services.providers.languageModel('env-llm/deepseek-reasoner', {
      memberId: lin.id,
      conversationId: 'cnv_1',
    });
    await generateText({ model, prompt: 'hi' });
    const [usage] = await getDb().select().from(usageEvents).where(eq(usageEvents.memberId, lin.id));
    expect(usage).toMatchObject({
      capability: 'llm',
      providerId: 'env-llm',
      source: 'env',
      model: 'deepseek-reasoner',
      inputTokens: 7,
      outputTokens: 2,
      conversationId: 'cnv_1',
    });
    await expect(services.providers.languageModel('env-llm/gpt-9', { memberId: lin.id })).rejects.toMatchObject({
      code: 'model_unavailable',
    });
  });

  it('falls back to the next instance on a retriable failure', async () => {
    const net = network((url) =>
      url.origin === 'https://api.deepseek.com' ? new Response('busy', { status: 503 }) : completion('qwen-plus'),
    );
    const { call, member, services } = createTestApp(ENV, { fetch: net.fetch });
    const admin = await member('admin');
    await call('POST', '/api/admin/providers', { token: admin.token, body: corpQwen });
    const result = await generateText({
      model: await services.providers.languageModel('default', { memberId: admin.id }),
      prompt: 'hi',
      maxRetries: 0,
    });
    expect(result.text).toBe('OK');
    expect(net.calls.map((entry) => entry.url.origin)).toEqual([
      'https://api.deepseek.com',
      'https://dashscope.aliyuncs.com',
    ]);
  });

  it('lets members use their own key only when allowed, and only for themselves', async () => {
    const { call, member, services, net } = setup();
    const admin = await member('admin');
    const lin = await member();
    const mine = {
      capability: 'llm',
      kind: 'openai-compatible',
      preset: 'deepseek',
      name: 'My DeepSeek',
      config: { baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' },
      secrets: { apiKey: 'sk-lin-own-0003' },
    };

    const denied = await call('POST', '/api/me/providers', { token: lin.token, body: mine });
    expect(denied.status).toBe(403);
    expect((await call('GET', '/api/me/providers', { token: lin.token })).body.capabilities).toEqual([]);

    await call('PUT', '/api/admin/provider-bindings/llm', {
      token: admin.token,
      body: { instance_ids: ['env-llm'], policy: { allow_personal: true } },
    });
    const created = await call('POST', '/api/me/providers', { token: lin.token, body: mine });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ source: 'personal', secrets_set: ['apiKey'] });

    const view = await call('GET', '/api/me/providers', { token: lin.token });
    expect(view.body.capabilities).toEqual([
      expect.objectContaining({
        capability: 'llm',
        allowed: true,
        active: 'personal',
        instances: [expect.objectContaining({ id: created.body.id })],
      }),
    ]);
    expect(view.body.catalog.every((adapter: { capability: string }) => adapter.capability === 'llm')).toBe(true);

    await generateText({
      model: await services.providers.languageModel('default', { memberId: lin.id }),
      prompt: 'hi',
    });
    expect(net.calls.at(-1)!.authorization).toBe('Bearer sk-lin-own-0003');
    // Someone else, or a run that must not use personal keys, gets the workspace key.
    await generateText({
      model: await services.providers.languageModel('default', { memberId: admin.id }),
      prompt: 'hi',
    });
    expect(net.calls.at(-1)!.authorization).toBe(`Bearer ${ENV_KEY}`);
    await generateText({
      model: await services.providers.languageModel('default', { memberId: lin.id, personal: false }),
      prompt: 'hi',
    });
    expect(net.calls.at(-1)!.authorization).toBe(`Bearer ${ENV_KEY}`);

    // Admins never see members' personal instances, and members cannot touch each other's.
    const adminView = await call('GET', '/api/admin/providers', { token: admin.token });
    expect(JSON.stringify(adminView.body)).not.toContain(created.body.id);
    const chen = await member();
    expect((await call('DELETE', `/api/me/providers/${created.body.id}`, { token: chen.token })).status).toBe(404);
    expect((await call('DELETE', `/api/me/providers/${created.body.id}`, { token: lin.token })).status).toBe(204);
  });

  it('keeps member endpoints on the public internet', async () => {
    const { call, member } = setup();
    const admin = await member('admin');
    const lin = await member();
    await call('PUT', '/api/admin/provider-bindings/llm', {
      token: admin.token,
      body: { instance_ids: ['env-llm'], policy: { allow_personal: true } },
    });
    const attempt = (baseUrl: string) =>
      call('POST', '/api/me/providers', {
        token: lin.token,
        body: {
          capability: 'llm',
          kind: 'openai-compatible',
          name: 'Mine',
          config: { baseUrl, defaultModel: 'm' },
          secrets: { apiKey: 'k' },
        },
      });
    for (const baseUrl of [
      'http://api.example.com/v1',
      'https://127.0.0.1/v1',
      'https://10.0.0.8/v1',
      'https://localhost/v1',
    ]) {
      const result = await attempt(baseUrl);
      expect(result.status, baseUrl).toBe(400);
      expect(result.body.error.code).toBe('invalid_input');
    }
    // Admins may point a workspace instance at a local model server.
    const local = await call('POST', '/api/admin/providers', {
      token: admin.token,
      body: {
        capability: 'llm',
        kind: 'openai-compatible',
        preset: 'ollama',
        name: 'Ollama',
        config: { baseUrl: 'http://localhost:11434/v1', defaultModel: 'qwen3' },
      },
    });
    expect(local.status).toBe(201);
    // Personal keys are not offered for shared infrastructure.
    const storage = await call('PUT', '/api/admin/provider-bindings/storage', {
      token: admin.token,
      body: { instance_ids: ['builtin-storage'], policy: { allow_personal: true } },
    });
    expect(storage.status).toBe(400);
  });

  it('clears keys when the endpoint moves, and validates settings and secret fields', async () => {
    const { call, member } = setup();
    const admin = await member('admin');
    const created = await call('POST', '/api/admin/providers', { token: admin.token, body: corpQwen });
    const renamed = await call('PATCH', `/api/admin/providers/${created.body.id}`, {
      token: admin.token,
      body: { name: 'Qwen' },
    });
    expect(renamed.body).toMatchObject({ name: 'Qwen', secrets_set: ['apiKey'] });
    const moved = await call('PATCH', `/api/admin/providers/${created.body.id}`, {
      token: admin.token,
      body: { config: { ...corpQwen.config, baseUrl: 'https://qwen.example.com/v1' } },
    });
    expect(moved.body.secrets_set).toEqual([]);
    const [record] = await getDb().select().from(auditEvents).orderBy(desc(auditEvents.id)).limit(1);
    expect(record!.summary).toContain('secrets cleared');

    const badConfig = await call('POST', '/api/admin/providers', {
      token: admin.token,
      body: { ...corpQwen, config: { baseUrl: 'not a url' } },
    });
    expect(badConfig.status).toBe(400);
    const badSecret = await call('POST', '/api/admin/providers', {
      token: admin.token,
      body: { ...corpQwen, secrets: { password: 'x' } },
    });
    expect(badSecret.body.error.message).toContain('password');
    const badKind = await call('POST', '/api/admin/providers', {
      token: admin.token,
      body: { ...corpQwen, kind: 'nope' },
    });
    expect(badKind.status).toBe(400);
  });

  it('copies an env instance into an editable one that takes its place', async () => {
    const { call, member, services, net } = setup();
    const admin = await member('admin');
    const copied = await call('POST', '/api/admin/providers/env-llm/copy', { token: admin.token });
    expect(copied.status).toBe(201);
    expect(copied.body).toMatchObject({ id: 'deepseek', source: 'workspace', secrets_set: ['apiKey'] });
    const llm = (await call('GET', '/api/admin/providers', { token: admin.token })).body.capabilities.find(
      (entry: { capability: string }) => entry.capability === 'llm',
    );
    expect(llm).toMatchObject({
      order: ['deepseek'],
      bound: true,
      defaults: { default: 'deepseek/deepseek-chat', strong: 'deepseek/deepseek-reasoner' },
    });
    await generateText({
      model: await services.providers.languageModel('strong', { memberId: admin.id }),
      prompt: 'hi',
    });
    expect(net.calls.at(-1)).toMatchObject({ authorization: `Bearer ${ENV_KEY}`, model: 'deepseek-reasoner' });

    // Deleting it drops it from the order and the defaults.
    expect((await call('DELETE', '/api/admin/providers/deepseek', { token: admin.token })).status).toBe(204);
    const after = (await call('GET', '/api/admin/providers', { token: admin.token })).body.capabilities.find(
      (entry: { capability: string }) => entry.capability === 'llm',
    );
    expect(after).toMatchObject({ order: [], defaults: {} });
  });

  it('appends a new instance to a saved order and rejects defaults outside it', async () => {
    const { call, member } = setup();
    const admin = await member('admin');
    await call('PUT', '/api/admin/provider-bindings/llm', { token: admin.token, body: { instance_ids: ['env-llm'] } });
    const created = await call('POST', '/api/admin/providers', { token: admin.token, body: corpQwen });
    const llm = (await call('GET', '/api/admin/providers', { token: admin.token })).body.capabilities.find(
      (entry: { capability: string }) => entry.capability === 'llm',
    );
    expect(llm.order).toEqual(['env-llm', created.body.id]);

    for (const body of [
      { instance_ids: ['nope'] },
      { instance_ids: ['env-llm'], defaults: { default: 'corp-qwen/qwen-max' } },
      { instance_ids: ['env-llm'], defaults: { default: 'env-llm/gpt-9' } },
      { instance_ids: ['env-llm'], defaults: { smart: 'env-llm/deepseek-chat' } },
    ]) {
      expect((await call('PUT', '/api/admin/provider-bindings/llm', { token: admin.token, body })).status).toBe(400);
    }
    expect(
      (await call('PUT', '/api/admin/provider-bindings/nope', { token: admin.token, body: { instance_ids: [] } }))
        .status,
    ).toBe(400);
  });

  it('tests a connection and never echoes the key in the result', async () => {
    const net = network((url) =>
      url.origin === 'https://api.deepseek.com'
        ? completion('deepseek-chat')
        : new Response(JSON.stringify({ error: { message: `invalid key sk-qwen-secret-0002` } }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
    );
    const { call, member } = createTestApp(ENV, { fetch: net.fetch });
    const admin = await member('admin');
    const ok = await call('POST', '/api/admin/providers/env-llm/test', { token: admin.token });
    expect(ok.body.last_check).toMatchObject({ ok: true });

    const created = await call('POST', '/api/admin/providers', { token: admin.token, body: corpQwen });
    const failed = await call('POST', `/api/admin/providers/${created.body.id}/test`, { token: admin.token });
    expect(failed.body.last_check.ok).toBe(false);
    expect(failed.body.last_check.error).toContain('***');
    expect(failed.body.last_check.error).not.toContain('sk-qwen');
    const [row] = await getDb().select().from(providers).where(eq(providers.id, created.body.id));
    expect(row!.lastCheck).toMatchObject({ ok: false });
    // A test is not usage.
    expect(await getDb().select().from(usageEvents)).toHaveLength(0);
  });

  it('reports which capabilities can serve on /health', async () => {
    const { call } = setup();
    const health = await call('GET', '/health');
    expect(health.body).toMatchObject({ ok: true, services: { llm: true, storage: true, search: false } });
    const bare = createTestApp();
    expect((await bare.call('GET', '/health')).body.services.llm).toBe(false);
  });
});
