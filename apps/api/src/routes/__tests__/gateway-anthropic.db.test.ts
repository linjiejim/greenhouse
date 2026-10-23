/**
 * The model gateway's Anthropic surface (what Claude Code talks to) against
 * real PostgreSQL and a fake Anthropic Messages upstream: key auth through
 * x-api-key or Bearer, Anthropic-shaped lists and errors, non-stream and stream
 * passthrough settled from message_start + message_delta usage (cache reads at
 * the cached price), a disconnect left reserved, the over-budget body, upstream
 * refusals released and sanitized, and count_tokens answered locally.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_REGISTRY, setModelRegistry } from '@greenhouse/agent-core';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

import { invalidateWorkspaceConfigCache } from '../../settings/workspace-config.js';
import { budgetExceededMessage } from '../../usage/budget-errors.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { _waitForGatewayCalls, createAnthropicGatewayRoutes } from '../gateway.js';

const UPSTREAM_KEY = 'sk-fake-anthropic-key-999888777';
const KEY_ENV = 'GW_TEST_ANTHROPIC_KEY';
const BASE = '/api/gateway/anthropic';

interface SeenRequest {
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
  raw: string;
}

type Behavior = 'json' | 'stream' | 'stream-error' | 'hang' | 'eof' | 'eof-data' | 'eof-comment' | 'error400';

let upstream: Server;
let upstreamBase = '';
let behavior: Behavior = 'json';
let seen: SeenRequest[] = [];
let hangClosed: Promise<void> = Promise.resolve();
let markHangClosed: () => void = () => undefined;

const START_USAGE = { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 1 };

function event(res: ServerResponse, name: string, payload: unknown) {
  res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function handle(req: IncomingMessage, res: ServerResponse) {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    seen.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}'), raw });
    const start = () =>
      event(res, 'message_start', {
        type: 'message_start',
        message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'upstream-claude-x', usage: START_USAGE },
      });
    const delta = (text: string) =>
      event(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      });
    switch (behavior) {
      case 'json':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'upstream-claude-x',
            content: [{ type: 'text', text: 'hello' }],
            stop_reason: 'end_turn',
            usage: { ...START_USAGE, output_tokens: 8 },
          }),
        );
        return;
      case 'stream':
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        start();
        delta('hel');
        setTimeout(() => {
          delta('lo');
          event(res, 'message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 8 },
          });
          event(res, 'message_stop', { type: 'message_stop' });
          res.end();
        }, 20);
        return;
      case 'stream-error':
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        start();
        event(res, 'error', {
          type: 'error',
          error: { type: 'overloaded_error', message: `Overloaded at ${upstreamBase} for ${UPSTREAM_KEY}` },
        });
        res.end();
        return;
      case 'eof':
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        start();
        delta('partial');
        setTimeout(() => res.end(), 20); // closes without message_delta / message_stop
        return;
      case 'eof-data':
      case 'eof-comment':
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        start();
        // The last event comes without its blank line before the close.
        res.end(
          behavior === 'eof-data'
            ? `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'tail' } })}`
            : ': keepalive',
        );
        return;
      case 'hang':
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        start();
        delta('partial');
        res.on('close', () => markHangClosed());
        return;
      case 'error400':
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: `max_tokens too large (key ${UPSTREAM_KEY})` },
          }),
        );
        return;
    }
  });
}

let db: DatabaseProvider;
let member: UserRow;
let admin: UserRow;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function app() {
  const hono = new Hono();
  hono.route(BASE, createAnthropicGatewayRoutes());
  return hono;
}

async function newKey(owner: UserRow, input: { allowed_models?: string[] } = {}) {
  const secret = `ghgw_${unique('anthropic')}_${'y'.repeat(24)}`;
  const row = await db.gatewayKeys.create({ user_id: owner.id, name: unique('key'), secret, ...input });
  return { secret, row };
}

const MESSAGE = { model: 'gw-claude', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] };

function messages(secret: string | null, body: Record<string, unknown>, init: RequestInit & { path?: string } = {}) {
  return app().request(`${BASE}${init.path ?? '/v1/messages'}`, {
    method: 'POST',
    ...init,
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(secret ? { 'x-api-key': secret } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
    body: JSON.stringify(body),
  });
}

async function reservationStatuses(keyId: string): Promise<string[]> {
  const rows = (await db.executeRaw(
    sql`SELECT DISTINCT status FROM usage_budget_reservations WHERE idempotency_key LIKE ${`gateway:${keyId}:%`}`,
  )) as Array<{ status: string }>;
  return rows.map((row) => row.status).sort();
}

async function facts(userId: string) {
  return (await db.executeRaw(
    sql`SELECT model, input_tokens, output_tokens, cached_tokens, cost_usd_micros::int AS cost_usd_micros, client, gateway_key_id
          FROM llm_usage WHERE user_id = ${userId} ORDER BY id`,
  )) as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  upstream = createServer(handle);
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/anthropic`;
  process.env[KEY_ENV] = UPSTREAM_KEY;
  setModelRegistry({
    'gw-claude': {
      name: 'Claude-wire test',
      contextWindow: 64_000,
      price: { input: 1, output: 2, cachedInput: 0.5 },
      providers: [
        {
          provider: 'deepseek',
          model: 'upstream-claude-x',
          apiKeyEnv: KEY_ENV,
          baseUrl: 'http://127.0.0.1:9/never-used',
          anthropicBaseUrl: upstreamBase,
        },
      ],
    },
    'gw-openai-only': {
      name: 'OpenAI wire only',
      providers: [{ provider: 'openai-compatible', model: 'x', apiKeyEnv: KEY_ENV, baseUrl: 'http://127.0.0.1:9/v1' }],
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
  behavior = 'json';
  seen = [];
  member = await createInternalTestUser(db, { email: `${unique('gwa-member')}@test.local` });
  admin = await createInternalTestUser(db, { email: `${unique('gwa-admin')}@test.local`, role: 'super' });
  await db.workspaceSettings.set('gateway.enabled', { value: true }, admin.id);
  invalidateWorkspaceConfigCache();
});

afterEach(async () => {
  await _waitForGatewayCalls();
  delete process.env.GATEWAY_UPSTREAM_IDLE_TIMEOUT_MS;
  invalidateWorkspaceConfigCache();
  await db.close();
  _resetProvider();
});

describe('Anthropic surface', () => {
  it('takes the key as x-api-key or Bearer and answers in Anthropic’s error shape', async () => {
    const { secret } = await newKey(member);
    const list = (headers: Record<string, string>) => app().request(`${BASE}/v1/models`, { headers });
    expect((await list({ 'x-api-key': secret })).status).toBe(200);
    expect((await list({ authorization: `Bearer ${secret}` })).status).toBe(200);
    const missing = await list({});
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      type: 'error',
      error: { type: 'authentication_error', message: expect.stringContaining('gateway key') },
    });
  });

  it('lists only models with an Anthropic endpoint, Anthropic-shaped', async () => {
    const { secret } = await newKey(member);
    const res = await app().request(`${BASE}/v1/models`, { headers: { 'x-api-key': secret } });
    expect(await res.json()).toEqual({
      data: [{ type: 'model', id: 'gw-claude', display_name: 'Claude-wire test', created_at: '1970-01-01T00:00:00Z' }],
      has_more: false,
      first_id: 'gw-claude',
      last_id: 'gw-claude',
    });
    const one = await app().request(`${BASE}/v1/models/gw-openai-only`, { headers: { 'x-api-key': secret } });
    expect(one.status).toBe(404);
    expect((await one.json()) as unknown).toMatchObject({ type: 'error', error: { type: 'not_found_error' } });
    const call = await messages(secret, { ...MESSAGE, model: 'gw-openai-only' });
    expect(call.status).toBe(503);
  });

  it('forwards a non-stream call with the upstream key only and settles cache-aware usage', async () => {
    const { secret, row } = await newKey(member);
    const res = await messages(
      secret,
      { ...MESSAGE, system: 'be brief', tools: [{ name: 'lookup', input_schema: { type: 'object' } }] },
      {
        path: '/v1/messages?beta=true',
        headers: { authorization: `Bearer ${secret}`, 'anthropic-beta': 'prompt-caching-2024-07-31' },
      },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { content: Array<{ text: string }> }).content[0]!.text).toBe('hello');

    const forwarded = seen[0]!;
    expect(forwarded.url).toBe('/anthropic/v1/messages?beta=true');
    expect(forwarded.headers['x-api-key']).toBe(UPSTREAM_KEY);
    expect(forwarded.headers.authorization).toBeUndefined();
    expect(forwarded.headers['anthropic-version']).toBe('2023-06-01');
    expect(forwarded.headers['anthropic-beta']).toBe('prompt-caching-2024-07-31');
    expect(JSON.stringify(forwarded.headers)).not.toContain('ghgw_');
    expect(forwarded.raw).not.toContain('ghgw_');
    expect(forwarded.body).toMatchObject({ model: 'upstream-claude-x', system: 'be brief', max_tokens: 1024 });

    expect(await reservationStatuses(row.id)).toEqual(['settled']);
    // 16 input (10 + 4 cache read + 2 cache write): 12 × $1 + 4 × $0.5 + 8 out × $2, per 1M → 30 micros.
    expect(await facts(member.id)).toEqual([
      expect.objectContaining({
        model: 'upstream-claude-x',
        input_tokens: 16,
        output_tokens: 8,
        cached_tokens: 4,
        cost_usd_micros: 30,
        client: 'gateway',
        gateway_key_id: row.id,
      }),
    ]);
  });

  it('passes the SSE stream through and settles from message_start + message_delta', async () => {
    behavior = 'stream';
    const { secret, row } = await newKey(member);
    const res = await messages(secret, { ...MESSAGE, stream: true });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    for (const name of ['message_start', 'content_block_delta', 'message_delta', 'message_stop']) {
      expect(text).toContain(`event: ${name}`);
    }
    expect(text).toContain('"text":"lo"');
    expect(text).not.toContain('event: error');
    await _waitForGatewayCalls();
    expect(await reservationStatuses(row.id)).toEqual(['settled']);
    expect(await facts(member.id)).toEqual([
      expect.objectContaining({ input_tokens: 16, output_tokens: 8, cached_tokens: 4, cost_usd_micros: 30 }),
    ]);
  });

  it('sanitizes an in-stream error event and leaves the call reserved', async () => {
    behavior = 'stream-error';
    const { secret, row } = await newKey(member);
    const text = await (await messages(secret, { ...MESSAGE, stream: true })).text();
    expect(text).toContain('event: error');
    expect(text).toContain('overloaded_error');
    expect(text).not.toContain('ended before the answer');
    expect(text).not.toContain(UPSTREAM_KEY);
    expect(text).not.toContain('127.0.0.1');
    await _waitForGatewayCalls();
    expect(await reservationStatuses(row.id)).toEqual(['reserved']);
  });

  it('leaves a call the client hung up on reserved and closes the upstream', async () => {
    behavior = 'hang';
    hangClosed = new Promise<void>((resolve) => (markHangClosed = resolve));
    const { secret, row } = await newKey(member);
    const res = await messages(secret, { ...MESSAGE, stream: true });
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('message_start');
    await reader.cancel();
    await hangClosed;
    await _waitForGatewayCalls();
    expect(await reservationStatuses(row.id)).toEqual(['reserved']);
    expect(await facts(member.id)).toEqual([]);
  });

  it('ends an idle stream with an Anthropic error event and keeps the reservation', async () => {
    behavior = 'hang';
    process.env.GATEWAY_UPSTREAM_IDLE_TIMEOUT_MS = '120';
    hangClosed = new Promise<void>((resolve) => (markHangClosed = resolve));
    const { secret, row } = await newKey(member);
    const text = await (await messages(secret, { ...MESSAGE, stream: true })).text();
    expect(text).toContain('partial');
    expect(text.trim().split('\n\n').at(-1)).toMatch(/^event: error\ndata: .*"type":"timeout_error"/);
    await hangClosed;
    await _waitForGatewayCalls();
    expect(await reservationStatuses(row.id)).toEqual(['reserved']);
  });

  it('ends a stream the upstream closed early with an Anthropic error event', async () => {
    behavior = 'eof';
    const { secret, row } = await newKey(member);
    const text = await (await messages(secret, { ...MESSAGE, stream: true })).text();
    expect(text).toContain('partial');
    expect(text.trim().split('\n\n').at(-1)).toMatch(/^event: error\ndata: .*"type":"api_error"/);
    await _waitForGatewayCalls();
    expect(await reservationStatuses(row.id)).toEqual(['reserved']);
  });

  it.each(['eof-data', 'eof-comment'] as const)(
    'keeps the stream well-formed when the upstream closes mid-event (%s)',
    async (how) => {
      behavior = how;
      const { secret } = await newKey(member);
      const text = await (await messages(secret, { ...MESSAGE, stream: true })).text();
      expect(text.endsWith('\n\n')).toBe(true);
      const events = text.trim().split('\n\n');
      for (const event of events) {
        expect(event).toMatch(/^event: [a-z_]+\ndata: /);
        expect(() => JSON.parse(event.slice(event.indexOf('data: ') + 'data: '.length))).not.toThrow();
      }
      expect(events.at(-1)).toMatch(/^event: error\ndata: .*"type":"api_error"/);
      if (how === 'eof-data') expect(text).toContain('"text":"tail"');
      await _waitForGatewayCalls();
    },
  );

  it('refuses over budget with the bilingual message, before any provider I/O', async () => {
    await db.metering.setLimit({ scope_type: 'user', scope_id: member.id, limit_units: 0, actor_id: admin.id });
    const { secret } = await newKey(member);
    const res = await messages(secret, MESSAGE);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: budgetExceededMessage({ unit: 'usd_micros', level: 'member' }) },
    });
    expect(seen).toHaveLength(0);
  });

  it('releases an upstream refusal and shows it without the upstream key', async () => {
    behavior = 'error400';
    const { secret, row } = await newKey(member);
    const res = await messages(secret, MESSAGE);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('max_tokens too large');
    expect(body.error.message).not.toContain(UPSTREAM_KEY);
    expect(await reservationStatuses(row.id)).toEqual(['released']);
  });

  it('requires max_tokens, and answers count_tokens locally without metering', async () => {
    const { secret, row } = await newKey(member);
    const missing = await messages(secret, { model: 'gw-claude', messages: [{ role: 'user', content: 'hi' }] });
    expect(missing.status).toBe(400);
    const counted = await messages(
      secret,
      { model: 'gw-claude', messages: [{ role: 'user', content: 'hello there' }] },
      { path: '/v1/messages/count_tokens' },
    );
    expect(counted.status).toBe(200);
    expect(((await counted.json()) as { input_tokens: number }).input_tokens).toBeGreaterThan(0);
    expect(seen).toHaveLength(0);
    expect(await reservationStatuses(row.id)).toEqual([]);
  });
});
