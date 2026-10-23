/**
 * The model gateway end to end against real PostgreSQL and a fake upstream (a
 * local HTTP server speaking OpenAI Chat Completions): the switch, key auth,
 * the allow-list, non-stream and stream proxying, settlement from the final
 * usage chunk, a client disconnect left to the unknown-outcome rule, upstream
 * refusals released, the over-budget body, the member's key never forwarded,
 * the key routes (member and super) and their Activity log entries.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_REGISTRY, setModelRegistry } from '@greenhouse/agent-core';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { GatewayKeyCreated, GatewayOverview } from '@greenhouse/types/agent-access';

import type { AppEnv } from '../../app-env.js';
import { isPublicPath, requireInternal, requireSuper } from '../../auth/middleware.js';
import { corsMiddleware } from '../../security/security.js';
import { invalidateWorkspaceConfigCache } from '../../settings/workspace-config.js';
import { budgetExceededMessage } from '../../usage/budget-errors.js';
import { buildMySpend } from '../../usage/report.js';
import { listActivity } from '../../activity/activity-log.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { _waitForGatewayCalls, createGatewayRoutes } from '../gateway.js';
import { createAgentAccessRoutes } from '../agent-access.js';
import adminMeteringRoutes from '../admin-metering.js';

const UPSTREAM_KEY = 'sk-fake-upstream-key-000111222';
const KEY_ENV = 'GW_TEST_UPSTREAM_KEY';
const BASE = '/api/gateway/openai/v1';

// ─── Fake upstream ───────────────────────────────────────

interface SeenRequest {
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
  raw: string;
}

type Behavior =
  | 'json'
  | 'stream'
  | 'hang'
  | 'silent'
  | 'cut'
  | 'eof'
  | 'eof-data'
  | 'eof-partial'
  | 'eof-comment'
  | 'error400'
  | 'error500';

let upstream: Server;
let upstreamUrl = '';
let behavior: Behavior = 'json';
let seen: SeenRequest[] = [];
let hangClosed: Promise<void> = Promise.resolve();
let markHangClosed: () => void = () => undefined;

const USAGE = { prompt_tokens: 12, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 2 } };

function sse(res: ServerResponse, payload: unknown) {
  res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
}

function handle(req: IncomingMessage, res: ServerResponse) {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    seen.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}'), raw });
    const chunk = (content: string) => ({
      id: 'c1',
      object: 'chat.completion.chunk',
      model: 'upstream-model-x',
      choices: [{ index: 0, delta: { content } }],
      usage: null,
    });
    switch (behavior) {
      case 'json':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'cmpl-1',
            object: 'chat.completion',
            model: 'upstream-model-x',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
            usage: USAGE,
          }),
        );
        return;
      case 'stream':
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        sse(res, chunk('hel'));
        setTimeout(() => {
          sse(res, chunk('lo'));
          sse(res, { id: 'c1', object: 'chat.completion.chunk', choices: [], usage: USAGE });
          sse(res, '[DONE]');
          res.end();
        }, 20);
        return;
      case 'hang':
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        sse(res, chunk('partial'));
        res.on('close', () => markHangClosed());
        return; // never finishes; waits for the gateway to hang up
      case 'cut':
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        sse(res, chunk('partial'));
        setTimeout(() => res.destroy(), 20); // connection dropped mid-answer
        return;
      case 'eof':
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        sse(res, chunk('partial'));
        setTimeout(() => res.end(), 20); // clean close, but no finish, usage or [DONE]
        return;
      case 'eof-data':
      case 'eof-partial':
      case 'eof-comment':
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        sse(res, chunk('partial'));
        // The last event comes without its blank line before the close.
        res.end(
          behavior === 'eof-data'
            ? `data: ${JSON.stringify(chunk('tail'))}`
            : behavior === 'eof-partial'
              ? 'data: {"choices":[{"delta":{"cont'
              : ': keepalive',
        );
        return;
      case 'silent':
        res.on('close', () => markHangClosed());
        return; // never answers, not even headers
      case 'error400':
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: `Invalid tools schema (key ${UPSTREAM_KEY} at ${upstreamUrl}/chat/completions)`,
              type: 'invalid_request_error',
              code: 'invalid_tools',
            },
          }),
        );
        return;
      case 'error500':
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `boom at ${upstreamUrl}` } }));
        return;
    }
  });
}

// ─── Fixtures ────────────────────────────────────────────

let db: DatabaseProvider;
let member: UserRow;
let otherMember: UserRow;
let admin: UserRow;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function gatewayApp() {
  const app = new Hono();
  app.use('*', corsMiddleware);
  app.route(BASE, createGatewayRoutes());
  return app;
}

function memberApp() {
  const users = new Map([member, otherMember, admin].map((user) => [user.id, user]));
  const hono = new Hono<AppEnv>();
  hono.use('*', async (c, next) => {
    const user = users.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role } as never);
    return next();
  });
  hono.use('/api/agent-access/*', requireInternal());
  hono.route('/api/agent-access', createAgentAccessRoutes());
  hono.use('/api/admin/*', requireSuper());
  hono.route('/api/admin/metering', adminMeteringRoutes);
  return hono;
}

async function asUser(user: UserRow, method: string, path: string, body?: unknown) {
  const res = await memberApp().request(path, {
    method,
    headers: { 'x-test-user': user.id, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

async function enableGateway(on = true) {
  await db.workspaceSettings.set('gateway.enabled', { value: on }, admin.id);
  invalidateWorkspaceConfigCache();
}

async function newKey(owner: UserRow, input: { allowed_models?: string[]; expires_at?: string } = {}) {
  const secret = `ghgw_${unique('test')}_${'x'.repeat(24)}`;
  const row = await db.gatewayKeys.create({ user_id: owner.id, name: unique('key'), secret, ...input });
  return { secret, row };
}

function chat(secret: string | null, body: Record<string, unknown>, init: RequestInit = {}) {
  return gatewayApp().request(`${BASE}/chat/completions`, {
    method: 'POST',
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
    body: JSON.stringify(body),
  });
}

/**
 * One entry per call: the token reservation group (one row per account) with
 * its USD twin (`<key>:usd`), and the one status every row of both shares.
 */
async function reservations(keyId: string) {
  const rows = (await db.executeRaw(
    sql`SELECT idempotency_key, status, estimated_units::int AS estimated_units, actual_units::int AS actual_units
          FROM usage_budget_reservations WHERE idempotency_key LIKE ${`gateway:${keyId}:%`}`,
  )) as Array<{ idempotency_key: string; status: string; estimated_units: number; actual_units: number | null }>;
  const calls = new Map<string, typeof rows>();
  for (const row of rows) {
    const call = row.idempotency_key.replace(/:usd$/, '');
    calls.set(call, [...(calls.get(call) ?? []), row]);
  }
  return [...calls.entries()].map(([key, group]) => {
    const tokens = group.filter((row) => row.idempotency_key === key);
    const statuses = [...new Set(group.map((row) => row.status))];
    return {
      idempotency_key: key,
      status: statuses.length === 1 ? statuses[0]! : `mixed:${statuses.join(',')}`,
      has_usd: group.some((row) => row.idempotency_key.endsWith(':usd')),
      estimated_units: tokens[0]?.estimated_units ?? 0,
      actual_units: tokens[0]?.actual_units ?? null,
    };
  });
}

async function facts(userId: string) {
  return (await db.executeRaw(
    sql`SELECT model, input_tokens, output_tokens, cached_tokens, cost_usd_micros::int AS cost_usd_micros, client, service, caller, budget_idempotency_key, gateway_key_id
          FROM llm_usage WHERE user_id = ${userId} ORDER BY id`,
  )) as Array<Record<string, any>>;
}

beforeAll(async () => {
  upstream = createServer(handle);
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  process.env[KEY_ENV] = UPSTREAM_KEY;
  setModelRegistry({
    'gw-test': {
      name: 'Gateway test',
      contextWindow: 32_000,
      options: { max_tokens: 1_000 },
      price: { input: 1, output: 2, cachedInput: 0.5 },
      providers: [
        { provider: 'openai-compatible', model: 'upstream-model-x', apiKeyEnv: KEY_ENV, baseUrl: upstreamUrl },
      ],
    },
    'gw-other': {
      name: 'Other',
      providers: [{ provider: 'openai-compatible', model: 'upstream-other', apiKeyEnv: KEY_ENV, baseUrl: upstreamUrl }],
    },
    'gw-unreachable': {
      name: 'No key',
      providers: [
        { provider: 'openai-compatible', model: 'nope', apiKeyEnv: 'GW_TEST_UNSET_KEY', baseUrl: upstreamUrl },
      ],
    },
  });
});

afterAll(async () => {
  setModelRegistry(DEFAULT_MODEL_REGISTRY);
  delete process.env[KEY_ENV];
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  invalidateWorkspaceConfigCache();
  behavior = 'json';
  seen = [];
  member = await createInternalTestUser(db, { email: `${unique('gw-member')}@test.local` });
  otherMember = await createInternalTestUser(db, { email: `${unique('gw-other')}@test.local` });
  admin = await createInternalTestUser(db, { email: `${unique('gw-admin')}@test.local`, role: 'super' });
});

afterEach(async () => {
  await _waitForGatewayCalls();
  delete process.env.GATEWAY_RATE_LIMIT_PER_MINUTE;
  delete process.env.GATEWAY_UPSTREAM_TIMEOUT_MS;
  delete process.env.GATEWAY_UPSTREAM_IDLE_TIMEOUT_MS;
  invalidateWorkspaceConfigCache();
  await db.close();
  _resetProvider();
});

// ─── Boundary ────────────────────────────────────────────

describe('boundary', () => {
  it('is a public path (key-only auth), and nothing else under /api/gateway is', () => {
    expect(isPublicPath(`${BASE}/chat/completions`)).toBe(true);
    expect(isPublicPath('/api/gateway-keys')).toBe(false);
    expect(isPublicPath('/api/gateway')).toBe(false);
  });

  it('keeps CORS closed even for an allowed web origin', async () => {
    const preflight = await gatewayApp().request(`${BASE}/models`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:3100', 'access-control-request-method': 'GET' },
    });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses every call while the workspace switch is off', async () => {
    const { secret } = await newKey(member);
    const res = await chat(secret, { model: 'gw-test', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(403);
    expect((await res.json()) as unknown).toMatchObject({ error: { code: 'gateway_disabled' } });
    await enableGateway(false);
    expect(
      (await gatewayApp().request(`${BASE}/models`, { headers: { authorization: `Bearer ${secret}` } })).status,
    ).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

describe('keys', () => {
  beforeEach(() => enableGateway());

  it('rejects a missing, unknown, revoked or expired key', async () => {
    const body = { model: 'gw-test', messages: [{ role: 'user', content: 'hi' }] };
    const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
    const missing = await chat(null, body);
    expect([missing.status, await code(missing)]).toEqual([401, 'invalid_api_key']);
    const wrong = await chat('ghgw_not-a-real-key', body);
    expect([wrong.status, await code(wrong)]).toEqual([401, 'invalid_api_key']);

    const { secret, row } = await newKey(member);
    await db.gatewayKeys.revoke({ id: row.id, revoked_by: member.id });
    const revoked = await chat(secret, body);
    expect([revoked.status, await code(revoked)]).toEqual([401, 'gateway_key_revoked']);

    const expired = await newKey(member, { expires_at: '2020-01-01T00:00:00.000Z' });
    const res = await chat(expired.secret, body);
    expect([res.status, await code(res)]).toEqual([401, 'gateway_key_expired']);
    expect(seen).toHaveLength(0);
  });

  it('lists the models a key may use, and enforces its allow-list', async () => {
    const open = await newKey(member);
    const list = await gatewayApp().request(`${BASE}/models`, { headers: { authorization: `Bearer ${open.secret}` } });
    const listed = (await list.json()) as { object: string; data: Array<{ id: string; owned_by: string }> };
    expect(listed.object).toBe('list');
    expect(listed.data.map((model) => model.id)).toEqual(['gw-test', 'gw-other']);
    expect(listed.data.every((model) => model.owned_by === 'greenhouse')).toBe(true);

    const narrow = await newKey(member, { allowed_models: ['gw-other'] });
    const narrowed = await gatewayApp().request(`${BASE}/models`, {
      headers: { authorization: `Bearer ${narrow.secret}` },
    });
    expect(((await narrowed.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id)).toEqual(['gw-other']);

    const refused = await chat(narrow.secret, { model: 'gw-test', messages: [{ role: 'user', content: 'hi' }] });
    expect(refused.status).toBe(403);
    expect((await refused.json()) as unknown).toMatchObject({ error: { code: 'model_not_allowed', param: 'model' } });
    const unknown = await chat(open.secret, { model: 'gpt-nope', messages: [{ role: 'user', content: 'hi' }] });
    expect(unknown.status).toBe(404);
    const unreachable = await chat(open.secret, {
      model: 'gw-unreachable',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(unreachable.status).toBe(503);
    expect(seen).toHaveLength(0);
  });

  it('rate-limits per key', async () => {
    process.env.GATEWAY_RATE_LIMIT_PER_MINUTE = '1';
    const { secret } = await newKey(member);
    const models = () => gatewayApp().request(`${BASE}/models`, { headers: { authorization: `Bearer ${secret}` } });
    expect((await models()).status).toBe(200);
    const limited = await models();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect((await limited.json()) as unknown).toMatchObject({ error: { code: 'rate_limit_exceeded' } });
  });
});

// ─── Proxying + metering ─────────────────────────────────

describe('proxying', () => {
  beforeEach(() => enableGateway());

  it('forwards a non-stream call with the upstream key only and settles its usage', async () => {
    const { secret, row } = await newKey(member);
    const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
    const res = await chat(
      secret,
      {
        model: 'gw-test',
        messages: [{ role: 'user', content: 'hi' }],
        tools,
        response_format: { type: 'json_object' },
      },
      { headers: { 'x-api-key': secret, cookie: `token=${secret}` } },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }>; usage: unknown };
    expect(json.choices[0]!.message.content).toBe('hello');

    expect(seen).toHaveLength(1);
    const forwarded = seen[0]!;
    expect(forwarded.url).toBe('/v1/chat/completions');
    expect(forwarded.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(forwarded.body).toMatchObject({
      model: 'upstream-model-x',
      tools,
      response_format: { type: 'json_object' },
    });
    // The member's key goes nowhere upstream: not a header, not the body.
    expect(JSON.stringify(forwarded.headers)).not.toContain('ghgw_');
    expect(forwarded.raw).not.toContain('ghgw_');
    expect(forwarded.headers.cookie).toBeUndefined();
    expect(forwarded.headers['x-api-key']).toBeUndefined();

    const [reservation] = await reservations(row.id);
    expect(reservation).toMatchObject({ status: 'settled', actual_units: 20 });
    // 10 uncached × $1 + 2 cached × $0.5 + 8 out × $2, per 1M tokens → 27 micros.
    expect(await facts(member.id)).toEqual([
      expect.objectContaining({
        model: 'upstream-model-x',
        input_tokens: 12,
        output_tokens: 8,
        cached_tokens: 2,
        cost_usd_micros: 27,
        client: 'gateway',
        service: 'llm',
        caller: 'gateway',
        budget_idempotency_key: reservation!.idempotency_key,
        gateway_key_id: row.id,
      }),
    ]);
    const spend = await buildMySpend(db, member.id);
    expect(spend.by_client.find((entry) => entry.key === 'gateway')).toMatchObject({ cost_usd_micros: 27 });
    expect((await db.gatewayKeys.getById(row.id))?.last_used_at).toBeTruthy();
  });

  it('streams SSE through, forces include_usage upstream and settles from the final chunk', async () => {
    behavior = 'stream';
    const { secret, row } = await newKey(member);
    const res = await chat(secret, { model: 'gw-test', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('"content":"hel"');
    expect(text).toContain('"content":"lo"');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
    // The client did not ask for usage, so the usage-only chunk is not relayed.
    expect(text).not.toContain('"prompt_tokens"');
    expect(seen[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });

    await _waitForGatewayCalls();
    expect(await reservations(row.id)).toEqual([expect.objectContaining({ status: 'settled', actual_units: 20 })]);
    expect(await facts(member.id)).toEqual([
      expect.objectContaining({ input_tokens: 12, output_tokens: 8, cost_usd_micros: 27, client: 'gateway' }),
    ]);
  });

  it('relays the usage chunk to a client that asked for it', async () => {
    behavior = 'stream';
    const { secret } = await newKey(member);
    const res = await chat(secret, {
      model: 'gw-test',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(await res.text()).toContain('"prompt_tokens":12');
  });

  it('leaves a call the client hung up on reserved (unknown outcome) and closes the upstream', async () => {
    behavior = 'hang';
    hangClosed = new Promise<void>((resolve) => (markHangClosed = resolve));
    const { secret, row } = await newKey(member);
    const res = await chat(secret, { model: 'gw-test', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('partial');
    await reader.cancel();
    await hangClosed;
    await _waitForGatewayCalls();

    const [reservation] = await reservations(row.id);
    expect(reservation).toMatchObject({ status: 'reserved', actual_units: null });
    expect(reservation!.estimated_units).toBeGreaterThan(1_000);
    expect(await facts(member.id)).toEqual([]);
  });

  it('times out an upstream that never answers: 504, reservation kept, connection closed', async () => {
    behavior = 'silent';
    process.env.GATEWAY_UPSTREAM_TIMEOUT_MS = '150';
    hangClosed = new Promise<void>((resolve) => (markHangClosed = resolve));
    const { secret, row } = await newKey(member);
    const res = await chat(secret, { model: 'gw-test', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(504);
    expect((await res.json()) as unknown).toMatchObject({ error: { type: 'timeout_error', code: 'upstream_timeout' } });
    await hangClosed;
    expect(await reservations(row.id)).toEqual([expect.objectContaining({ status: 'reserved' })]);
  });

  it('ends an idle stream with an error chunk and keeps the reservation', async () => {
    behavior = 'hang';
    process.env.GATEWAY_UPSTREAM_IDLE_TIMEOUT_MS = '120';
    hangClosed = new Promise<void>((resolve) => (markHangClosed = resolve));
    const { secret, row } = await newKey(member);
    const res = await chat(secret, { model: 'gw-test', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const text = await res.text();
    expect(text).toContain('partial');
    const last = text.trim().split('\n\n').at(-1)!;
    expect(JSON.parse(last.slice('data: '.length))).toMatchObject({
      error: { type: 'timeout_error', code: 'upstream_timeout' },
    });
    await hangClosed;
    await _waitForGatewayCalls();
    expect(await reservations(row.id)).toEqual([expect.objectContaining({ status: 'reserved' })]);
  });

  it.each(['cut', 'eof'] as const)(
    'ends a stream the upstream broke off (%s) with an error chunk and keeps the reservation',
    async (how) => {
      behavior = how;
      const { secret, row } = await newKey(member);
      const res = await chat(secret, { model: 'gw-test', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      const text = await res.text();
      expect(text).toContain('partial');
      const last = text.trim().split('\n\n').at(-1)!;
      expect(JSON.parse(last.slice('data: '.length))).toMatchObject({
        error: { type: 'api_error', code: 'upstream_interrupted' },
      });
      expect(text).not.toContain('127.0.0.1');
      await _waitForGatewayCalls();
      expect(await reservations(row.id)).toEqual([expect.objectContaining({ status: 'reserved' })]);
    },
  );

  it.each(['eof-data', 'eof-partial', 'eof-comment'] as const)(
    'keeps the stream well-formed when the upstream closes mid-event (%s)',
    async (how) => {
      behavior = how;
      const { secret } = await newKey(member);
      const res = await chat(secret, { model: 'gw-test', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      const text = await res.text();
      expect(text.endsWith('\n\n')).toBe(true);
      const events = text.trim().split('\n\n');
      // Every event is one complete `data:` line with parseable JSON.
      for (const event of events) {
        expect(event.startsWith('data: ')).toBe(true);
        expect(() => JSON.parse(event.slice('data: '.length))).not.toThrow();
      }
      expect(JSON.parse(events.at(-1)!.slice('data: '.length))).toMatchObject({
        error: { code: 'upstream_interrupted' },
      });
      if (how === 'eof-data') expect(text).toContain('"content":"tail"');
      await _waitForGatewayCalls();
    },
  );

  it('refuses over budget before any provider I/O, with the bilingual message', async () => {
    await db.metering.setLimit({ scope_type: 'user', scope_id: member.id, limit_units: 0, actor_id: admin.id });
    const { secret } = await newKey(member);
    const res = await chat(secret, { model: 'gw-test', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: {
        message: budgetExceededMessage({ unit: 'usd_micros', level: 'member' }),
        type: 'insufficient_quota',
        code: 'usage_budget_exceeded',
        param: null,
      },
    });
    expect(seen).toHaveLength(0);
  });

  it('releases an upstream refusal and never shows the upstream key or URL', async () => {
    behavior = 'error400';
    const { secret, row } = await newKey(member);
    const res = await chat(secret, { model: 'gw-test', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain('Invalid tools schema');
    expect(text).toContain('invalid_tools');
    expect(text).not.toContain(UPSTREAM_KEY);
    expect(text).not.toContain('127.0.0.1');
    expect(await reservations(row.id)).toEqual([expect.objectContaining({ status: 'released' })]);
  });

  it('keeps an upstream failure (5xx) reserved', async () => {
    behavior = 'error500';
    const { secret, row } = await newKey(member);
    const res = await chat(secret, { model: 'gw-test', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain('upstream_error');
    expect(text).not.toContain('127.0.0.1');
    expect(await reservations(row.id)).toEqual([expect.objectContaining({ status: 'reserved' })]);
  });

  it('rejects a malformed request before reserving', async () => {
    const { secret, row } = await newKey(member);
    const res = await chat(secret, { model: 'gw-test', messages: 'hi' });
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toMatchObject({ error: { param: 'messages' } });
    expect(await reservations(row.id)).toEqual([]);
  });
});

// ─── Key routes ──────────────────────────────────────────

describe('key routes', () => {
  it('lets a member create (only while on), list and revoke their own keys', async () => {
    const off = await asUser(member, 'POST', '/api/agent-access/gateway/keys', { name: 'laptop' });
    expect(off.status).toBe(403);
    await enableGateway();

    const bad = await asUser(member, 'POST', '/api/agent-access/gateway/keys', {
      name: 'x',
      allowed_models: ['gpt-nope'],
    });
    expect(bad.status).toBe(400);

    const created = await asUser(member, 'POST', '/api/agent-access/gateway/keys', {
      name: 'laptop',
      allowed_models: ['gw-test'],
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(created.status).toBe(201);
    const { key, secret } = created.json as unknown as GatewayKeyCreated;
    expect(secret).toMatch(/^ghgw_[A-Za-z0-9_-]{40,}$/);
    expect(key).toMatchObject({ name: 'laptop', allowed_models: ['gw-test'], status: 'active' });
    expect(secret.startsWith(key.prefix)).toBe(true);
    // The secret works on the gateway, and its spend shows on the key.
    expect((await chat(secret, { model: 'gw-test', messages: [{ role: 'user', content: 'hi' }] })).status).toBe(200);
    await _waitForGatewayCalls();

    const overview = (await asUser(member, 'GET', '/api/agent-access/gateway')).json as unknown as GatewayOverview;
    expect(overview.enabled).toBe(true);
    expect(overview.base_url.endsWith('/api/gateway/openai/v1')).toBe(true);
    expect(overview.models.map((model) => model.id)).toEqual(['gw-test', 'gw-other']);
    expect(overview.keys.map((view) => view.id)).toEqual([key.id]);
    expect(overview.keys[0]).toMatchObject({ month_spend_usd_micros: 27, month_calls: 1 });
    expect(overview.models.find((model) => model.id === 'gw-test')).toMatchObject({ openai: true, anthropic: false });
    expect(JSON.stringify(overview)).not.toContain(secret);

    expect((await asUser(otherMember, 'DELETE', `/api/agent-access/gateway/keys/${key.id}`)).status).toBe(404);
    const revoked = await asUser(member, 'DELETE', `/api/agent-access/gateway/keys/${key.id}`);
    expect(revoked).toMatchObject({ status: 200, json: { key: { status: 'revoked' } } });
    expect((await chat(secret, { model: 'gw-test', messages: [{ role: 'user', content: 'hi' }] })).status).toBe(401);

    const page = await listActivity(db, member, { module: 'mcp', source: 'person' }, { manifests: [] });
    const actions = page.items.map((item) => [item.action, item.target?.label]);
    expect(actions).toEqual(
      expect.arrayContaining([
        ['createGatewayKey', 'laptop'],
        ['revokeGatewayKey', 'laptop'],
      ]),
    );
  });

  it('lets only a super list and revoke every member’s keys', async () => {
    const { row } = await newKey(member);
    expect((await asUser(member, 'GET', '/api/admin/metering/gateway-keys')).status).toBe(403);
    expect((await asUser(member, 'DELETE', `/api/admin/metering/gateway-keys/${row.id}`)).status).toBe(403);

    const listed = await asUser(admin, 'GET', '/api/admin/metering/gateway-keys');
    expect(listed.status).toBe(200);
    expect(listed.json.enabled).toBe(false);
    expect(listed.json.switch).toEqual({ override: null, fallback: false, effective: false, source: 'default' });
    const mine = (
      listed.json.keys as Array<{ id: string; owner: { id: string }; month_spend_usd_micros: number }>
    ).find((key) => key.id === row.id);
    expect(mine?.owner.id).toBe(member.id);
    expect(mine?.month_spend_usd_micros).toBe(0);
    expect(JSON.stringify(listed.json)).not.toContain(row.key_hash);

    const revoked = await asUser(admin, 'DELETE', `/api/admin/metering/gateway-keys/${row.id}`);
    expect(revoked).toMatchObject({ status: 200, json: { key: { status: 'revoked' } } });
    expect((await db.gatewayKeys.getById(row.id))?.revoked_by).toBe(admin.id);

    const page = await listActivity(db, admin, { source: 'admin', module: 'mcp' }, { manifests: [] });
    const item = page.items.find((entry) => entry.action === 'revokeMemberGatewayKey');
    expect(item?.target?.label).toBe(row.name);
    expect(item?.detail).toContain(row.key_prefix);
  });
});
