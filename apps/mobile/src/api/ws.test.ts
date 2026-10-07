/**
 * The realtime client (./ws.ts) with a fake socket and a virtual clock: every
 * close code of spec §2.7.2 (1000 ours / 4001 / 4002 / 4003 / 1006), backoff
 * with jitter, the 70 s watchdog, ping → pong, connected → resync, and a
 * stop/start cycle (background / foreground). Root vitest, no React Native.
 */

import { describe, expect, it } from 'vitest';
import type { RealtimeEvent, RealtimeStatus } from '../bots/contract';
import { FakeClock } from '../bots/thread/test-fakes';
import {
  BACKOFF_MS,
  COOLING_MS,
  parseFrame,
  RealtimeClient,
  realtimeUrl,
  STABLE_MS,
  WATCHDOG_CLOSE,
  WATCHDOG_MS,
} from './ws';

interface FakeSocket {
  url: string;
  sent: string[];
  closedWith: number | null;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onclose: ((e: { code: number }) => void) | null;
}

function setup(o: { refresh?: () => Promise<boolean>; random?: () => number; url?: () => string | null } = {}) {
  const time = new FakeClock();
  const sockets: FakeSocket[] = [];
  class Socket implements FakeSocket {
    url: string;
    sent: string[] = [];
    closedWith: number | null = null;
    onopen: FakeSocket['onopen'] = null;
    onmessage: FakeSocket['onmessage'] = null;
    onerror: FakeSocket['onerror'] = null;
    onclose: FakeSocket['onclose'] = null;
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close(code?: number) {
      this.closedWith = code ?? 1000;
    }
  }
  const refreshes = { count: 0 };
  const client = new RealtimeClient({
    WebSocketImpl: Socket as unknown as typeof WebSocket,
    url: o.url ?? (() => 'wss://api.test/api/ws?token=t'),
    refreshTokens: async () => {
      refreshes.count += 1;
      return o.refresh ? o.refresh() : true;
    },
    clock: time.clock,
    random: o.random ?? (() => 0.5),
  });
  const events: RealtimeEvent[] = [];
  const statuses: RealtimeStatus[] = [];
  client.on((e) => events.push(e));
  client.onStatus((s) => statuses.push(s));
  const last = () => sockets[sockets.length - 1];
  /** The newest socket opens and the server accepts it. */
  const accept = () => {
    last().onopen?.({});
    last().onmessage?.({ data: JSON.stringify({ type: 'connected', userId: 'u1' }) });
  };
  const close = (code: number) => last().onclose?.({ code });
  return { time, sockets, client, events, statuses, last, accept, close, refreshes };
}

describe('realtimeUrl / parseFrame', () => {
  it('points at /api/ws on the API host, with the token encoded', () => {
    expect(realtimeUrl('https://green.example.com/', 'a b+c')).toBe('wss://green.example.com/api/ws?token=a%20b%2Bc');
    expect(realtimeUrl('http://localhost:18905', 't')).toBe('ws://localhost:18905/api/ws?token=t');
  });

  it('reads the five frames mobile uses and drops everything else', () => {
    expect(parseFrame('{"type":"ping"}')).toEqual({ type: 'ping' });
    expect(parseFrame('{"type":"connected","userId":"u1"}')).toEqual({ type: 'connected', userId: 'u1' });
    expect(parseFrame('{"type":"chat:run","sessionId":"s","runId":"r","status":"completed"}')).toEqual({
      type: 'chat:run',
      sessionId: 's',
      runId: 'r',
      status: 'completed',
    });
    expect(parseFrame('{"type":"bots:conversation","sessionId":"s"}')).toEqual({ type: 'bots:conversation', sessionId: 's' });
    expect(parseFrame('{"type":"bots:attention","pending":3}')).toEqual({ type: 'bots:attention', pending: 3 });
    expect(parseFrame('{"type":"notification:new","id":1}')).toBeNull();
    expect(parseFrame('{"type":"chat:run","sessionId":"s","status":"running"}')).toBeNull();
    expect(parseFrame('{"type":"chat:run","sessionId":"s","runId":"r","status":"weird"}')).toBeNull();
    expect(parseFrame('{"type":"bots:attention","pending":"3"}')).toBeNull();
    expect(parseFrame('not json')).toBeNull();
    expect(parseFrame(42)).toBeNull();
  });
});

describe('RealtimeClient', () => {
  it('is open only once the server accepted (connected), which makes everyone resync', async () => {
    const t = setup();
    expect(t.client.status).toBe('off');
    t.client.start();
    expect(t.client.status).toBe('connecting');
    expect(t.last().url).toBe('wss://api.test/api/ws?token=t');
    t.last().onopen?.({});
    expect(t.client.status).toBe('connecting');
    expect(t.client.downSince()).not.toBeNull();
    t.last().onmessage?.({ data: JSON.stringify({ type: 'connected', userId: 'u1' }) });
    expect(t.client.status).toBe('open');
    expect(t.client.downSince()).toBeNull();
    expect(t.events).toEqual([{ type: 'resync' }]);
    // A second start() while connected is a no-op.
    t.client.start();
    expect(t.sockets).toHaveLength(1);
  });

  it('answers ping with pong; delivers the Bots pushes; drops the rest', () => {
    const t = setup();
    t.client.start();
    t.accept();
    t.last().onmessage?.({ data: '{"type":"ping"}' });
    expect(t.last().sent).toEqual(['{"type":"pong"}']);
    t.last().onmessage?.({ data: '{"type":"chat:run","sessionId":"s1","runId":"r1","status":"running"}' });
    t.last().onmessage?.({ data: '{"type":"bots:conversation","sessionId":"s1"}' });
    t.last().onmessage?.({ data: '{"type":"bots:attention","pending":2}' });
    t.last().onmessage?.({ data: '{"type":"notification:new","notification":{}}' });
    t.last().onmessage?.({ data: '{oops' });
    expect(t.events).toEqual([
      { type: 'resync' },
      { type: 'chat:run', sessionId: 's1', runId: 'r1', status: 'running' },
      { type: 'bots:conversation', sessionId: 's1' },
      { type: 'bots:attention', pending: 2 },
    ]);
  });

  it('our own close (1000, background) is final until the next start; the next start resyncs again', async () => {
    const t = setup();
    t.client.start();
    t.accept();
    const first = t.last();
    t.client.stop();
    expect(first.closedWith).toBe(1000);
    expect(t.client.status).toBe('off');
    // The socket's late close is ignored.
    first.onclose?.({ code: 1000 });
    await t.time.advance(120_000);
    expect(t.sockets).toHaveLength(1);
    t.client.start();
    t.accept();
    expect(t.sockets).toHaveLength(2);
    expect(t.events.filter((e) => e.type === 'resync')).toHaveLength(2);
  });

  it('unexpected closes back off 1 → 2 → 4 → 8 → 16 → 30 s (then 30 s), reset by a stable connection', async () => {
    const t = setup();
    t.client.start();
    const delays: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      t.close(1006);
      expect(t.client.status).toBe('backoff');
      delays.push(t.time.pending()[0]);
      await t.time.advance(t.time.pending()[0]);
      expect(t.client.status).toBe('connecting');
    }
    expect(delays).toEqual([...BACKOFF_MS, 30_000]);

    // A connection that stays up 30 s ends the cycle: the next drop starts at 1 s again.
    t.accept();
    await t.time.advance(STABLE_MS);
    t.last().onmessage?.({ data: '{"type":"ping"}' });
    t.close(1006);
    expect(t.time.pending()[0]).toBe(1_000);
  });

  it('a server-side 1000/1001 (restart) is reconnected like any drop', async () => {
    const t = setup();
    t.client.start();
    t.accept();
    t.close(1001);
    expect(t.client.status).toBe('backoff');
    await t.time.advance(1_000);
    expect(t.sockets).toHaveLength(2);
  });

  it('jitters each delay by ±20 %', () => {
    const low = setup({ random: () => 0 });
    low.client.start();
    low.close(1006);
    expect(low.time.pending()[0]).toBe(800);
    const high = setup({ random: () => 0.9999 });
    high.client.start();
    high.close(1006);
    expect(high.time.pending()[0]).toBe(1_200);
  });

  it('4001: one refresh, then reconnect at once; a second 4001 in the cycle stops', async () => {
    const t = setup();
    t.client.start();
    t.last().onopen?.({});
    t.close(4001);
    await t.time.advance(0);
    expect(t.refreshes.count).toBe(1);
    expect(t.sockets).toHaveLength(2);
    expect(t.client.status).toBe('connecting');
    t.last().onopen?.({});
    t.close(4001);
    await t.time.advance(0);
    expect(t.refreshes.count).toBe(1);
    expect(t.client.status).toBe('stopped');
    await t.time.advance(10 * 60_000);
    expect(t.sockets).toHaveLength(2);
  });

  it('4001 with a failed refresh stops (no sign-out from here); start() tries again', async () => {
    const t = setup({ refresh: async () => false });
    t.client.start();
    t.close(4001);
    await t.time.advance(0);
    expect(t.client.status).toBe('stopped');
    expect(t.sockets).toHaveLength(1);
    t.client.stop();
    t.client.start();
    expect(t.sockets).toHaveLength(2);
  });

  it('4002 (expired on an open socket): refresh and reconnect; failure stops', async () => {
    const ok = setup();
    ok.client.start();
    ok.accept();
    await ok.time.advance(STABLE_MS);
    ok.close(4002);
    await ok.time.advance(0);
    expect(ok.refreshes.count).toBe(1);
    expect(ok.sockets).toHaveLength(2);
    // Stable again: the refresh allowance is back.
    ok.accept();
    await ok.time.advance(STABLE_MS);
    ok.close(4002);
    await ok.time.advance(0);
    expect(ok.refreshes.count).toBe(2);
    expect(ok.sockets).toHaveLength(3);

    const fails = setup({ refresh: async () => false });
    fails.client.start();
    fails.accept();
    fails.close(4002);
    await fails.time.advance(0);
    expect(fails.client.status).toBe('stopped');
  });

  it('4003 (too many sockets): cools down 60 s before reconnecting', async () => {
    const t = setup();
    t.client.start();
    t.accept();
    t.close(4003);
    expect(t.client.status).toBe('cooling');
    expect(t.client.downSince()).not.toBeNull();
    await t.time.advance(COOLING_MS - 1);
    expect(t.sockets).toHaveLength(1);
    await t.time.advance(1);
    expect(t.sockets).toHaveLength(2);
    expect(t.client.status).toBe('connecting');
  });

  it('70 s without any frame: the silent socket is dropped (4000) and replaced', async () => {
    const t = setup();
    t.client.start();
    t.accept();
    // Pings keep it alive.
    for (let i = 0; i < 4; i += 1) {
      await t.time.advance(30_000);
      t.last().onmessage?.({ data: '{"type":"ping"}' });
    }
    expect(t.sockets).toHaveLength(1);
    const silent = t.last();
    await t.time.advance(WATCHDOG_MS);
    expect(silent.closedWith).toBe(WATCHDOG_CLOSE);
    expect(t.client.status).toBe('backoff');
    // Its late close changes nothing.
    silent.onclose?.({ code: 1006 });
    await t.time.advance(1_000);
    expect(t.sockets).toHaveLength(2);
  });

  it('no token: stopped without a socket', () => {
    const t = setup({ url: () => null });
    t.client.start();
    expect(t.client.status).toBe('stopped');
    expect(t.sockets).toHaveLength(0);
  });

  it('reports status changes and when it went down', async () => {
    const t = setup();
    t.client.start();
    t.accept();
    await t.time.advance(5_000);
    const at = t.time.clock.now();
    t.close(1006);
    expect(t.client.downSince()).toBe(at);
    expect(t.statuses).toEqual(['connecting', 'open', 'backoff']);
  });
});
