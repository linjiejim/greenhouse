/**
 * The realtime client (./realtime.ts) with a fake socket and a fake clock: the hello handshake,
 * resync after every ready, the 4401 refresh rule, backoff with its reset after a stable
 * connection, and a clean stop. Pure: runs in the ROOT vitest.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { REALTIME_SIGN_IN_AGAIN } from '../shared/contract';
import { BACKOFF_MS, parseFrame, RealtimeClient, realtimeUrl, STABLE_MS, type ClientEvent } from './realtime';

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: string[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data?: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code: number) {
    this.closedWith = code;
  }
  // test side
  open() {
    this.onopen?.();
  }
  frame(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  ready() {
    this.frame({ type: 'ready', data: {} });
  }
  drop(code: number) {
    this.onclose?.({ code });
  }
}

/** Timers run only when the test advances the clock. */
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
    pending: () => [...timers.values()].map((t) => t.at - now),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const last = () => FakeSocket.all[FakeSocket.all.length - 1]!;

let clock: ReturnType<typeof fakeClock>;
let refresh: () => Promise<boolean>;
let refreshes = 0;
let target: { url: string; token: string } | null;
let events: ClientEvent[];

function client() {
  const c = new RealtimeClient({
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    target: () => target,
    refreshTokens: () => {
      refreshes += 1;
      return refresh();
    },
    clock,
    random: () => 0.5, // no jitter
  });
  c.on((event) => events.push(event));
  return c;
}

beforeEach(() => {
  FakeSocket.all = [];
  clock = fakeClock();
  refreshes = 0;
  refresh = async () => true;
  target = { url: 'wss://a.example/api/ws', token: 'tok-1' };
  events = [];
});

describe('handshake', () => {
  it('says hello with the token once open (never in the URL), and is open only after ready', () => {
    const c = client();
    c.start();
    const ws = last();
    expect(ws.url).toBe('wss://a.example/api/ws');
    expect(c.status).toBe('connecting');
    ws.open();
    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([{ type: 'hello', data: { token: 'tok-1' } }]);
    expect(c.status).toBe('connecting');
    ws.ready();
    expect(c.status).toBe('open');
    expect(events).toEqual([{ type: 'resync', reconnected: false }]);
  });

  it('passes the server events on and drops what it does not know', () => {
    const c = client();
    c.start();
    last().open();
    last().ready();
    last().frame({ type: 'message.delta', data: { conversation_id: 'c1', message_id: 'm1', offset: 0, text: 'Hi' } });
    last().frame({ type: 'nope', data: {} });
    last().onmessage?.({ data: '{not json' });
    expect(events.slice(1)).toEqual([
      { type: 'message.delta', data: { conversation_id: 'c1', message_id: 'm1', offset: 0, text: 'Hi' } },
    ]);
  });

  it('stops at once with nothing to connect with (signed out)', () => {
    target = null;
    const c = client();
    c.start();
    expect(FakeSocket.all).toHaveLength(0);
    expect(c.status).toBe('stopped');
  });
});

describe('closing', () => {
  it('backs off 1, 2, 4… seconds after unexpected closes, and says it reconnected', () => {
    const c = client();
    c.start();
    last().open();
    last().ready();
    last().drop(1006);
    expect(c.status).toBe('backoff');
    expect(clock.pending()).toEqual([BACKOFF_MS[0]]);
    clock.advance(BACKOFF_MS[0]);
    expect(FakeSocket.all).toHaveLength(2);
    last().drop(1006);
    expect(clock.pending()).toEqual([BACKOFF_MS[1]]);
    clock.advance(BACKOFF_MS[1]);
    last().open();
    last().ready();
    expect(events.at(-1)).toEqual({ type: 'resync', reconnected: true });
  });

  it('starts the backoff over after a connection stayed open long enough', () => {
    const c = client();
    c.start();
    last().drop(1006);
    clock.advance(BACKOFF_MS[0]);
    last().drop(1006);
    clock.advance(BACKOFF_MS[1]);
    last().open();
    last().ready();
    clock.advance(STABLE_MS);
    last().drop(1006);
    expect(clock.pending()).toEqual([BACKOFF_MS[0]]);
    expect(c.status).toBe('backoff');
  });

  it('refreshes the token once on 4401 and reconnects; a second 4401 in the cycle stops', async () => {
    const c = client();
    c.start();
    last().drop(REALTIME_SIGN_IN_AGAIN);
    await flush();
    expect(refreshes).toBe(1);
    expect(FakeSocket.all).toHaveLength(2);
    last().drop(REALTIME_SIGN_IN_AGAIN);
    await flush();
    expect(refreshes).toBe(1);
    expect(c.status).toBe('stopped');
  });

  it('stops when the refresh fails', async () => {
    refresh = async () => false;
    const c = client();
    c.start();
    last().drop(REALTIME_SIGN_IN_AGAIN);
    await flush();
    expect(FakeSocket.all).toHaveLength(1);
    expect(c.status).toBe('stopped');
  });

  it('closes cleanly on stop and does not come back', () => {
    const c = client();
    c.start();
    const ws = last();
    ws.open();
    ws.ready();
    c.stop();
    expect(ws.closedWith).toBe(1000);
    expect(c.status).toBe('off');
    clock.advance(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('builds the socket URL on the API host', () => {
    expect(realtimeUrl('https://a.example/')).toBe('wss://a.example/api/ws');
    expect(realtimeUrl('http://127.0.0.1:4631')).toBe('ws://127.0.0.1:4631/api/ws');
  });

  it('reads only well-formed frames of known types', () => {
    expect(parseFrame('{"type":"run.updated","data":{"run_id":"r","status":"running","conversation_id":null}}')).toEqual({
      type: 'run.updated',
      data: { run_id: 'r', status: 'running', conversation_id: null },
    });
    expect(parseFrame('{"type":"run.updated"}')).toBeNull();
    expect(parseFrame(42)).toBeNull();
  });
});
