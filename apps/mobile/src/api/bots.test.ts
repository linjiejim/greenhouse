/**
 * The Bots API layer (./bots.ts) and the Bots additions to ./chat.ts. Runs in the ROOT vitest
 * unit project with the transport faked: `api()` (./client) and `expo/fetch` are mocked, so no
 * React Native module loads. Responses are real WHATWG `Response`s (Node's), so "was the body
 * read?" is observable.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
const expoFetchMock = vi.fn<(url: string, init: Record<string, unknown>) => Promise<Response>>();
const refreshMock = vi.fn<() => Promise<boolean>>();

vi.mock('./client', () => ({
  api: (path: string, init?: RequestInit) => apiMock(path, init),
  refreshTokens: () => refreshMock(),
}));
vi.mock('expo/fetch', () => ({ fetch: (url: string, init: Record<string, unknown>) => expoFetchMock(url, init) }));
vi.mock('./token-storage', () => ({ getAccessToken: () => 'access-token' }));
vi.mock('../store/stations', () => ({ getApiBase: () => 'http://api.test' }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));

import * as bots from './bots';
import { interruptChatRun, listChatRuns, openBotsChat, type RunStreamEvent } from './chat';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function drain(events: AsyncGenerator<RunStreamEvent>): Promise<RunStreamEvent[]> {
  const out: RunStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

beforeEach(() => {
  apiMock.mockReset();
  expoFetchMock.mockReset();
  refreshMock.mockReset();
});

// ─── openBotsChat ────────────────────────────────────────

describe('openBotsChat', () => {
  const send = (extra: Partial<Parameters<typeof openBotsChat>[0]> = {}) =>
    openBotsChat({ sessionId: 'sess_1', content: 'hello', ...extra });

  it('200: hands back the NDJSON stream, events in order', async () => {
    const lines = [
      { type: 'bot-turn-start', bot_id: 'bot_a', reason: 'user', seq: 0 },
      { type: 'text-delta', text: 'Hi', seq: 1 },
      { type: 'bot-turn-end', bot_id: 'bot_a', status: 'completed', message_id: 'm1', seq: 2 },
      { type: 'finish', finishReason: 'stop' },
    ];
    expoFetchMock.mockResolvedValue(new Response(lines.map((line) => JSON.stringify(line)).join('\n') + '\n'));
    const result = await send();
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    expect((await drain(result.events)).map((event) => event.type)).toEqual([
      'bot-turn-start',
      'text-delta',
      'bot-turn-end',
      'finish',
    ]);
  });

  it('202: queued, the body read to the end — never handed out as a stream', async () => {
    const res = json(202, { queued: true });
    expoFetchMock.mockResolvedValue(res);
    const result = await send();
    expect(result).toEqual({ kind: 'queued' });
    expect(res.bodyUsed).toBe(true);
  });

  it('409 with a code: the read-only refusal keeps its code and sentence', async () => {
    expoFetchMock.mockResolvedValue(json(409, { error: 'That Bot is archived', code: 'bot_archived' }));
    expect(await send()).toEqual({ kind: 'error', status: 409, code: 'bot_archived', message: 'That Bot is archived' });
  });

  it('403 / 404: refusals without a code', async () => {
    expoFetchMock.mockResolvedValueOnce(json(403, { error: 'Bots are not enabled for this account' }));
    expect(await send()).toEqual({
      kind: 'error',
      status: 403,
      code: null,
      message: 'Bots are not enabled for this account',
    });
    expoFetchMock.mockResolvedValueOnce(new Response('Not found', { status: 404 }));
    expect(await send()).toEqual({ kind: 'error', status: 404, code: null, message: 'Not found' });
  });

  it('no answer at all: status 0', async () => {
    expoFetchMock.mockRejectedValue(new TypeError('Network request failed'));
    expect(await send()).toEqual({ kind: 'error', status: 0, code: null, message: '' });
  });

  it('sends only the Bots fields: the message (+ images) and mentions when there are any', async () => {
    expoFetchMock.mockResolvedValue(json(202, { queued: true }));
    await send({ images: [{ id: 'img_1', url: '/api/upload/img_1' }], mentions: ['bot_b'] });
    await send({ mentions: [] });
    const [first, second] = expoFetchMock.mock.calls.map(([url, init]) => ({ url, init }));
    expect(first.url).toBe('http://api.test/api/chat');
    expect(first.init.method).toBe('POST');
    expect((first.init.headers as Record<string, string>).Authorization).toBe('Bearer access-token');
    expect(JSON.parse(first.init.body as string)).toEqual({
      session_id: 'sess_1',
      messages: [{ role: 'user', content: 'hello', images: [{ id: 'img_1', url: '/api/upload/img_1' }] }],
      mentions: ['bot_b'],
    });
    expect(JSON.parse(second.init.body as string)).toEqual({
      session_id: 'sess_1',
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('401: refreshes once and retries with the new token', async () => {
    expoFetchMock.mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(json(202, {}));
    refreshMock.mockResolvedValue(true);
    expect(await send()).toEqual({ kind: 'queued' });
    expect(expoFetchMock).toHaveBeenCalledTimes(2);
  });
});

// ─── interrupt / runs ────────────────────────────────────

describe('interruptChatRun', () => {
  it('maps 200 / 404 / anything else / no answer', async () => {
    apiMock.mockResolvedValueOnce(json(200, { ok: true, run_id: 'r1' }));
    expect(await interruptChatRun('sess_1')).toBe('interrupting');
    expect(apiMock).toHaveBeenLastCalledWith('/api/chat/runs/sess_1/interrupt', { method: 'POST' });
    apiMock.mockResolvedValueOnce(json(404, { error: 'No active generation for this session' }));
    expect(await interruptChatRun('sess_1')).toBe('no_run');
    apiMock.mockResolvedValueOnce(json(400, { code: 'not_supported' }));
    expect(await interruptChatRun('sess_1')).toBe('refused');
    apiMock.mockRejectedValueOnce(new TypeError('offline'));
    expect(await interruptChatRun('sess_1')).toBe('refused');
  });
});

describe('listChatRuns', () => {
  it('returns the runs, or null without a good answer', async () => {
    const runs = [{ session_id: 's1', run_id: 'r1', started_at: 1, next_seq: 4 }];
    apiMock.mockResolvedValueOnce(json(200, { runs }));
    expect(await listChatRuns()).toEqual(runs);
    apiMock.mockResolvedValueOnce(json(500, {}));
    expect(await listChatRuns()).toBeNull();
    apiMock.mockRejectedValueOnce(new TypeError('offline'));
    expect(await listChatRuns()).toBeNull();
  });
});

// ─── src/api/bots.ts ─────────────────────────────────────

describe('Bots reads', () => {
  it('unwrap the list, and tell 403 / 404 / network apart', async () => {
    const row = { session_id: 's1', last_activity_at: '2026-10-08T05:05:34.202Z' };
    apiMock.mockResolvedValueOnce(json(200, { conversations: [row] }));
    expect(await bots.listConversations()).toEqual({ ok: true, value: [row] });
    apiMock.mockResolvedValueOnce(json(403, { error: 'Forbidden: feature not enabled', feature: 'bots' }));
    expect(await bots.listConversations()).toEqual({ ok: false, status: 403, code: null });
    apiMock.mockResolvedValueOnce(new Response('<html>', { status: 404 }));
    expect(await bots.listBots()).toEqual({ ok: false, status: 404, code: null });
    apiMock.mockRejectedValueOnce(new TypeError('offline'));
    expect(await bots.listRequests('pending')).toEqual({ ok: false, status: 0, code: null });
    expect(apiMock).toHaveBeenLastCalledWith('/api/bots/requests?status=pending', {});
  });

  it('getConversation builds the page query and narrows unknown roles to a Bot reply', async () => {
    const message = (id: string, role: string) => ({ id, role, created_at: '2026-10-08T00:00:00.000Z', seq: 1 });
    apiMock.mockResolvedValue(
      json(200, {
        conversation: { session_id: 's 1' },
        messages: [message('a', 'user'), message('b', 'system'), message('c', 'tool')],
        has_more: true,
      }),
    );
    const page = await bots.getConversation('s 1', { beforeSeq: 40, limit: 60 });
    expect(apiMock).toHaveBeenLastCalledWith('/api/bots/conversations/s%201?before_seq=40&limit=60', {});
    expect(page.ok && page.value.messages.map((m) => m.role)).toEqual(['user', 'system', 'assistant']);
    await bots.getConversation('s1');
    expect(apiMock).toHaveBeenLastCalledWith('/api/bots/conversations/s1', {});
  });

  it('rewrites Postgres timestamps to ISO, and leaves content alone', async () => {
    apiMock.mockResolvedValue(
      json(200, {
        requests: [
          {
            id: 'r1',
            created_at: '2026-10-08 05:05:34.202+00',
            expires_at: '2026-10-08 05:07:24.2+0800',
            payload: { details: [{ label: 'updated_at', value: 'x' }], seen_at: '2026-10-08 05:05:34+00' },
          },
        ],
      }),
    );
    const result = await bots.listRequests();
    expect(apiMock).toHaveBeenLastCalledWith('/api/bots/requests', {});
    const request = result.ok ? (result.value[0] as unknown as Record<string, unknown>) : null;
    expect(request?.created_at).toBe('2026-10-08T05:05:34.202+00:00');
    expect(request?.expires_at).toBe('2026-10-08T05:07:24.200+08:00');
    expect((request?.payload as Record<string, unknown>).seen_at).toBe('2026-10-08 05:05:34+00');
  });

  it('isoTimestamp: zones, fractions, already-ISO and non-timestamps', () => {
    expect(bots.isoTimestamp('2026-10-08 05:05:34+00')).toBe('2026-10-08T05:05:34+00:00');
    expect(bots.isoTimestamp('2026-10-08 05:05:34.123456+05:30')).toBe('2026-10-08T05:05:34.123+05:30');
    expect(bots.isoTimestamp('2026-10-08T05:05:34.202Z')).toBe('2026-10-08T05:05:34.202Z');
    expect(bots.isoTimestamp('2026-10-08')).toBe('2026-10-08');
    expect(bots.isoTimestamp('soon')).toBe('soon');
    expect(Date.parse(bots.isoTimestamp('2026-10-08 05:05:34.202-07'))).toBe(Date.parse('2026-10-08T12:05:34.202Z'));
  });
});

describe('Bots writes', () => {
  it('carry the server code and sentence on a refusal', async () => {
    apiMock.mockResolvedValueOnce(json(400, { error: 'You already have a Bot called Fern', code: 'bot_name_taken' }));
    expect(await bots.createBot({ name: 'Fern' })).toEqual({
      ok: false,
      status: 400,
      code: 'bot_name_taken',
      message: 'You already have a Bot called Fern',
    });
    const [path, init] = apiMock.mock.calls[0];
    expect(path).toBe('/api/bots');
    expect(init).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Fern' }),
    });
  });

  it('decideRequest unwraps the settled request; a conflict keeps its code', async () => {
    const settled = { id: 'brq 1', status: 'resolved', created_at: '2026-10-08T00:00:00.000Z', expires_at: null };
    apiMock.mockResolvedValueOnce(json(200, { request: settled }));
    expect(await bots.decideRequest('brq 1', { decision: 'approve' })).toEqual({ ok: true, value: settled });
    expect(apiMock.mock.calls[0][0]).toBe('/api/bots/requests/brq%201');
    apiMock.mockResolvedValueOnce(json(409, { error: 'Already decided', code: 'already_decided' }));
    expect(await bots.decideRequest('brq 1', { decision: 'deny' })).toEqual({
      ok: false,
      status: 409,
      code: 'already_decided',
      message: 'Already decided',
    });
  });

  it('void writes, membership and read receipts', async () => {
    apiMock.mockResolvedValueOnce(json(200, { ok: true }));
    expect(await bots.archiveBot('bot_1')).toEqual({ ok: true, value: undefined });
    expect(apiMock).toHaveBeenLastCalledWith('/api/bots/bot_1', { method: 'DELETE' });
    apiMock.mockResolvedValueOnce(json(200, { conversation: { session_id: 's1', members: [] } }));
    expect(await bots.addConversationMember('s1', 'bot_2')).toEqual({
      ok: true,
      value: { session_id: 's1', members: [] },
    });
    apiMock.mockResolvedValueOnce(json(200, { ok: true }));
    expect(await bots.markConversationRead('s1')).toBe(true);
    apiMock.mockRejectedValueOnce(new TypeError('offline'));
    expect(await bots.markConversationRead('s1')).toBe(false);
    apiMock.mockResolvedValueOnce(json(409, { error: 'That task has already finished' }));
    expect(await bots.cancelBotTask('run_1')).toEqual({
      ok: false,
      status: 409,
      code: null,
      message: 'That task has already finished',
    });
  });
});
