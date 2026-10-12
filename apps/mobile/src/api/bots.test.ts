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
vi.mock('./token-storage', () => ({ getAccessToken: () => 'access-token', getTokenStationId: () => 'st-1' }));
vi.mock('../store/stations', () => ({ getApiBase: () => 'http://api.test' }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));

import * as bots from './bots';
import { interruptChatRun, listChatRuns, openBotsChat, openBotsRewind, type RunStreamEvent } from './chat';
import { MOBILE_RICH_BLOCKS } from '../chat/markdown/rich';

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

  it('sends only the Bots fields: the message (+ images), what the app draws, and mentions when there are any', async () => {
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
      rich_blocks: [...MOBILE_RICH_BLOCKS],
      mentions: ['bot_b'],
    });
    expect(JSON.parse(second.init.body as string)).toEqual({
      session_id: 'sess_1',
      messages: [{ role: 'user', content: 'hello' }],
      rich_blocks: [...MOBILE_RICH_BLOCKS],
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

  it('void writes, notes and read receipts', async () => {
    apiMock.mockResolvedValueOnce(json(200, { ok: true }));
    expect(await bots.archiveBot('bot_1')).toEqual({ ok: true, value: undefined });
    expect(apiMock).toHaveBeenLastCalledWith('/api/bots/bot_1', { method: 'DELETE' });
    apiMock.mockResolvedValueOnce(json(201, { note: { id: 7, title: 'Ship it' } }));
    expect(await bots.addNote('s 1', { title: 'Ship it' })).toEqual({ ok: true, value: { id: 7, title: 'Ship it' } });
    expect(apiMock.mock.calls.at(-1)?.[0]).toBe('/api/bots/conversations/s%201/notes');
    apiMock.mockResolvedValueOnce(json(200, { note: { id: 7, status: 'done' } }));
    expect(await bots.updateNote('s1', 7, { status: 'done' })).toEqual({ ok: true, value: { id: 7, status: 'done' } });
    expect(apiMock.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
    apiMock.mockResolvedValueOnce(json(200, { ok: true }));
    expect(await bots.markConversationRead('s1')).toBe(true);
    apiMock.mockResolvedValueOnce(json(200, { ok: true }));
    expect(await bots.markConversationRead('s1', 'm4')).toBe(true);
    expect(apiMock).toHaveBeenLastCalledWith(
      '/api/bots/conversations/s1/read',
      expect.objectContaining({
        body: JSON.stringify({ through_message_id: 'm4' }),
      }),
    );
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

describe('rating a public Agent’s reply (P4)', () => {
  it('rates (POST) and takes back (DELETE) on the reply’s feedback route', async () => {
    apiMock.mockResolvedValueOnce(json(200, { ok: true, rating: -1 }));
    expect(await bots.rateReply('s 1', 'm 1', { rating: -1, comment: 'wrong year' })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(apiMock.mock.calls.at(-1)?.[0]).toBe('/api/bots/conversations/s%201/messages/m%201/feedback');
    expect(apiMock.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'POST' });
    apiMock.mockResolvedValueOnce(json(200, { ok: true }));
    expect(await bots.unrateReply('s 1', 'm 1')).toEqual({ ok: true, value: undefined });
    expect(apiMock).toHaveBeenLastCalledWith('/api/bots/conversations/s%201/messages/m%201/feedback', {
      method: 'DELETE',
    });
    apiMock.mockResolvedValueOnce(json(404, { error: 'Reply not found' }));
    expect(await bots.unrateReply('s1', 'm_x')).toEqual({
      ok: false,
      status: 404,
      code: null,
      message: 'Reply not found',
    });
  });

  it('a page keeps the member’s ratings of its replies', async () => {
    apiMock.mockResolvedValueOnce(
      json(200, { conversation: { session_id: 's1' }, messages: [], has_more: false, my_ratings: { m1: 1, m2: -1 } }),
    );
    const page = await bots.getConversation('s1');
    expect(page.ok && page.value.my_ratings).toEqual({ m1: 1, m2: -1 });
  });
});

// ─── Task chats (spec 20261011-agent-first-class §5a) ────

describe('task chats', () => {
  it('lists them with ?kind=task — an older server answers with its threads: only task rows are kept', async () => {
    const task = { session_id: 't1', kind: 'task', last_activity_at: '2026-10-12T00:00:00.000Z' };
    const dm = { session_id: 'd1', kind: 'direct', last_activity_at: '2026-10-12T00:00:00.000Z' };
    apiMock.mockResolvedValueOnce(json(200, { conversations: [task, dm] }));
    expect(await bots.listTaskChats()).toEqual({ ok: true, value: [task] });
    expect(apiMock).toHaveBeenLastCalledWith('/api/bots/conversations?kind=task', {});
    apiMock.mockResolvedValueOnce(json(403, { error: 'Forbidden' }));
    expect(await bots.listTaskChats()).toEqual({ ok: false, status: 403, code: null });
  });

  it('creates one (kind task, the Agent when given) and reads an older server’s refusal as a plain 400', async () => {
    apiMock.mockResolvedValueOnce(json(201, { conversation: { session_id: 't1', kind: 'task' } }));
    expect(await bots.createTaskChat({ bot_id: 'bot_a' })).toEqual({
      ok: true,
      value: { session_id: 't1', kind: 'task' },
    });
    expect(apiMock.mock.calls.at(-1)).toEqual([
      '/api/bots/conversations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'task', bot_id: 'bot_a' }),
      },
    ]);
    apiMock.mockResolvedValueOnce(json(400, { error: 'bot_ids must be a list of Bot ids' }));
    expect(await bots.createTaskChat()).toEqual({
      ok: false,
      status: 400,
      code: null,
      message: 'bot_ids must be a list of Bot ids',
    });
    expect(apiMock.mock.calls.at(-1)?.[1]).toMatchObject({ body: JSON.stringify({ kind: 'task' }) });
  });

  it('renames one (PATCH), a DM refusing with its code', async () => {
    apiMock.mockResolvedValueOnce(json(200, { conversation: { session_id: 't 1', title: 'Plan' } }));
    expect(await bots.updateTaskChat('t 1', { title: 'Plan' })).toEqual({
      ok: true,
      value: { session_id: 't 1', title: 'Plan' },
    });
    expect(apiMock.mock.calls.at(-1)).toEqual([
      '/api/bots/conversations/t%201',
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Plan' }) },
    ]);
    apiMock.mockResolvedValueOnce(json(409, { error: 'Only a separate chat…', code: 'not_task_chat' }));
    expect(await bots.updateTaskChat('d1', { title: 'x' })).toMatchObject({ ok: false, code: 'not_task_chat' });
  });
});

describe('rooms (P5)', () => {
  const jsonBody = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('lists who the member can talk with; a server without rooms answers 404', async () => {
    const people = [{ id: 'u_ana', nickname: 'Ana', email: 'ana@x.test' }];
    apiMock.mockResolvedValueOnce(json(200, { people }));
    expect(await bots.listRoomPeople()).toEqual({ ok: true, value: people });
    expect(apiMock).toHaveBeenLastCalledWith('/api/rooms/people', {});
    apiMock.mockResolvedValueOnce(new Response('Not found', { status: 404 }));
    expect(await bots.listRoomPeople()).toEqual({ ok: false, status: 404, code: null });
  });

  it('creates one (201, or the pair’s private chat again — 200) with its timestamps in ISO', async () => {
    const conversation = { session_id: 'r1', kind: 'room', last_activity_at: '2026-10-12 04:00:00.5+00' };
    apiMock.mockResolvedValueOnce(json(201, { conversation }));
    expect(await bots.createRoom({ user_ids: ['u_ana'], title: 'Launch', bot_ids: ['b_sage'] })).toEqual({
      ok: true,
      value: { ...conversation, last_activity_at: '2026-10-12T04:00:00.500+00:00' },
    });
    expect(apiMock.mock.calls.at(-1)).toEqual([
      '/api/rooms',
      jsonBody('POST', { user_ids: ['u_ana'], title: 'Launch', bot_ids: ['b_sage'] }),
    ]);
    apiMock.mockResolvedValueOnce(json(200, { conversation: { session_id: 'r0', kind: 'room' } }));
    expect(await bots.createRoom({ user_ids: ['u_ana'] })).toMatchObject({ ok: true, value: { session_id: 'r0' } });
    apiMock.mockResolvedValueOnce(json(409, { error: 'At most 20 people in a room', code: 'room_full' }));
    expect(await bots.createRoom({ user_ids: ['u_ana'] })).toEqual({
      ok: false,
      status: 409,
      code: 'room_full',
      message: 'At most 20 people in a room',
    });
  });

  it('renames, adds and removes people (leaving is removing yourself), brings and removes Agents', async () => {
    const detail = { conversation: { session_id: 'r 1', kind: 'room' } };
    apiMock.mockResolvedValueOnce(json(200, detail));
    expect(await bots.renameRoom('r 1', 'Launch')).toMatchObject({ ok: true, value: { session_id: 'r 1' } });
    expect(apiMock.mock.calls.at(-1)).toEqual(['/api/rooms/r%201', jsonBody('PATCH', { title: 'Launch' })]);

    apiMock.mockResolvedValueOnce(json(200, detail));
    expect(await bots.addRoomPerson('r 1', 'u_bo')).toMatchObject({ ok: true });
    expect(apiMock.mock.calls.at(-1)).toEqual(['/api/rooms/r%201/participants', jsonBody('POST', { user_id: 'u_bo' })]);

    apiMock.mockResolvedValueOnce(json(200, { ok: true, deleted: false }));
    expect(await bots.removeRoomPerson('r 1', 'u_bo')).toEqual({ ok: true, value: { deleted: false } });
    expect(apiMock.mock.calls.at(-1)).toEqual(['/api/rooms/r%201/participants/u_bo', { method: 'DELETE' }]);

    apiMock.mockResolvedValueOnce(json(200, { ok: true, deleted: true }));
    expect(await bots.leaveRoom('r 1', 'u_me')).toEqual({ ok: true, value: { deleted: true } });
    expect(apiMock.mock.calls.at(-1)).toEqual(['/api/rooms/r%201/participants/u_me', { method: 'DELETE' }]);
    apiMock.mockResolvedValueOnce(json(409, { error: 'Their Agent is answering right now', code: 'busy' }));
    expect(await bots.leaveRoom('r 1', 'u_me')).toMatchObject({ ok: false, status: 409, code: 'busy' });

    apiMock.mockResolvedValueOnce(json(200, detail));
    expect(await bots.addRoomAgent('r 1', 'b_sage')).toMatchObject({ ok: true });
    expect(apiMock.mock.calls.at(-1)).toEqual(['/api/rooms/r%201/agents', jsonBody('POST', { bot_id: 'b_sage' })]);
    apiMock.mockResolvedValueOnce(json(409, { error: 'That Agent is not shared with everyone in this conversation' }));
    expect(await bots.addRoomAgent('r 1', 'b_pub')).toMatchObject({ ok: false, status: 409, code: null });

    apiMock.mockResolvedValueOnce(json(200, { ok: true }));
    expect(await bots.removeRoomAgent('r 1', 'b_sage')).toEqual({ ok: true, value: undefined });
    expect(apiMock.mock.calls.at(-1)).toEqual(['/api/rooms/r%201/agents/b_sage', { method: 'DELETE' }]);
  });
});

describe('openBotsRewind', () => {
  it('posts the message (and an edit’s text) with the rich blocks, and streams the run like a send', async () => {
    expoFetchMock.mockResolvedValue(new Response(`${JSON.stringify({ type: 'finish' })}\n`));
    const result = await openBotsRewind({ sessionId: 't 1', messageId: 'u9', content: 'Shorter, please' });
    expect(result.kind).toBe('stream');
    if (result.kind === 'stream') expect((await drain(result.events)).map((event) => event.type)).toEqual(['finish']);
    const [url, init] = expoFetchMock.mock.calls.at(-1)!;
    expect(url).toBe('http://api.test/api/bots/conversations/t%201/rewind');
    expect(JSON.parse(init.body as string)).toEqual({
      message_id: 'u9',
      content: 'Shorter, please',
      rich_blocks: [...MOBILE_RICH_BLOCKS],
    });
  });

  it('answer again sends no content; a refusal keeps the server’s code; no answer is status 0', async () => {
    expoFetchMock.mockResolvedValueOnce(json(409, { error: 'Busy', code: 'busy' }));
    expect(await openBotsRewind({ sessionId: 't1', messageId: 'u9' })).toEqual({
      kind: 'error',
      status: 409,
      code: 'busy',
      message: 'Busy',
    });
    expect(JSON.parse(expoFetchMock.mock.calls.at(-1)![1].body as string)).not.toHaveProperty('content');
    expoFetchMock.mockRejectedValueOnce(new TypeError('offline'));
    expect(await openBotsRewind({ sessionId: 't1', messageId: 'u9' })).toEqual({
      kind: 'error',
      status: 0,
      code: null,
      message: '',
    });
  });
});

// ─── One computer per Agent (spec 20261011-agent-first-class P3a) ─

describe('an Agent’s computer', () => {
  it('the main Agent’s computer needs no `?bot=`; any other Agent’s carries it on every call', () => {
    expect(bots.computerPath('/api/bots/computer', null)).toBe('/api/bots/computer');
    expect(bots.computerPath('/api/bots/computer')).toBe('/api/bots/computer');
    expect(bots.computerPath('/api/bots/computer', 'bot a')).toBe('/api/bots/computer?bot=bot%20a');
    expect(bots.computerPath('/api/bots/computer/files?path=%7E', 'bot_a')).toBe(
      '/api/bots/computer/files?path=%7E&bot=bot_a',
    );
    expect(bots.computerFilePath('/home/agent/a b.txt', 'bot_a')).toBe(
      '/api/bots/computer/files/download?path=%2Fhome%2Fagent%2Fa%20b.txt&bot=bot_a',
    );
  });

  it('status, start, ticket, lease, typing, files and processes all name the computer', async () => {
    apiMock.mockImplementation(async () => json(200, { ok: true, processes: [], token: 't', expires_at: 'x' }));
    await bots.computerStatus('bot_a');
    await bots.startComputer('bot_a');
    await bots.computerViewToken('bot_a');
    await bots.takeoverComputer('bot_a');
    await bots.handbackComputer({ bot: 'bot_a', sessionId: 's1' });
    await bots.typeIntoComputer('hi', 'bot_a');
    await bots.listComputerFiles(undefined, 'bot_a');
    await bots.listComputerProcesses('bot_a');
    await bots.computerProcessLog('j1', 50, 'bot_a');
    await bots.stopComputerProcess('j1', 'bot_a');
    expect(apiMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/bots/computer?bot=bot_a',
      '/api/bots/computer/start?bot=bot_a',
      '/api/bots/computer/view-token?bot=bot_a',
      '/api/bots/computer/takeover?bot=bot_a',
      '/api/bots/computer/handback?bot=bot_a',
      '/api/bots/computer/type?bot=bot_a',
      '/api/bots/computer/files?bot=bot_a',
      '/api/bots/computer/processes?bot=bot_a',
      '/api/bots/computer/processes/j1/log?lines=50&bot=bot_a',
      '/api/bots/computer/processes/j1/stop?bot=bot_a',
    ]);
    // the hand-back body is unchanged by which computer it is
    expect(JSON.parse(apiMock.mock.calls[4][1]!.body as string)).toEqual({ session_id: 's1' });
    apiMock.mockReset();
    apiMock.mockResolvedValue(json(200, {}));
    await bots.computerStatus();
    await bots.computerViewToken(null);
    expect(apiMock.mock.calls.map(([path]) => path)).toEqual(['/api/bots/computer', '/api/bots/computer/view-token']);
  });

  it('an Agent that is not the member’s answers 404 agent_not_found', async () => {
    apiMock.mockResolvedValueOnce(json(404, { error: 'Agent not found', code: 'agent_not_found' }));
    expect(await bots.computerStatus('bot_x')).toEqual({ ok: false, status: 404, code: 'agent_not_found' });
  });
});

describe('an Agent’s usage and activity', () => {
  it('reads 30 days of usage', async () => {
    const view = { days: [], totals: { calls: 0, input_tokens: 0, output_tokens: 0 } };
    apiMock.mockResolvedValueOnce(json(200, view));
    expect(await bots.botUsage('bot a')).toEqual({ ok: true, value: view });
    expect(apiMock.mock.calls[0][0]).toBe('/api/bots/bot%20a/usage?days=30');
  });

  it('reads the activity with `at` rewritten for Hermes (it is not an *_at key)', async () => {
    apiMock.mockResolvedValueOnce(
      json(200, {
        activity: [
          {
            at: '2026-10-12 05:05:34.202+00',
            kind: 'task',
            title: 'Report',
            outcome: 'succeeded',
            detail: null,
            session_id: 's1',
          },
        ],
      }),
    );
    const result = await bots.botActivity('bot_a', 20);
    expect(apiMock.mock.calls[0][0]).toBe('/api/bots/bot_a/activity?limit=20');
    expect(result.ok && result.value[0].at).toBe('2026-10-12T05:05:34.202+00:00');
    apiMock.mockResolvedValueOnce(json(404, { error: 'Agent not found' }));
    expect(await bots.botActivity('bot_x')).toEqual({ ok: false, status: 404, code: null });
  });
});
