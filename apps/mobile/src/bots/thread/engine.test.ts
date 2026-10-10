/**
 * ThreadEngine (./engine.ts) against fakes — the races of spec §2.7.6/2.7.7
 * (D5–D7, D9, D13, D14) on a virtual clock: sends (200 / 202 / 409 code /
 * network), the one-reader chain, the send latch, single-flight attach, run
 * identity on resume, the two-stage stop, "Handle Now", picked-up queued
 * messages, the remote-busy cadence, read receipts, push debouncing and the
 * polling discipline. Root vitest, no React Native.
 */

import { describe, expect, it } from 'vitest';
import type { BotsPost, ChatRunProbe, RunStreamEvent } from '../../api/chat';
import type { BotMessage, BotRequestView } from '../../shared/bots';
import type { RealtimeEvent, RealtimeStatus, ThreadEffect } from '../contract';
import type { BotsStoreDeps } from '../store-core';
import { ThreadCache } from './cache';
import {
  CONVERSATION_RELOAD_MS,
  DECIDE_PROBE_MS,
  MAX_RESUMES,
  POLL_PROBE_MS,
  REMOTE_BUSY_FIRST_MS,
  REMOTE_BUSY_MAX_MS,
  STALE_MS,
  ThreadEngine,
} from './engine';
import { POLL_GRACE_MS } from './polling';
import {
  deferred,
  FakeClock,
  FakeRealtime,
  FakeStream,
  FakeThreadApi,
  makeStore,
  message,
  page,
  request,
} from './test-fakes';

const SID = 's1';
const live = (runId: string) => ({
  active: true,
  run: { run_id: runId, status: 'running' as const, started_at: 0, next_seq: 0 },
});
const turnStart = (
  botId: string,
  reason: 'user' | 'interjection' | 'ask' = 'user',
  extra: Partial<RunStreamEvent> = {},
) => ({ type: 'bot-turn-start', bot_id: botId, reason, ...extra }) as RunStreamEvent;
const turnEnd = (botId: string, messageId?: string, extra: Partial<RunStreamEvent> = {}) =>
  ({ type: 'bot-turn-end', bot_id: botId, status: 'completed', message_id: messageId, ...extra }) as RunStreamEvent;
const text = (value: string, extra: Partial<RunStreamEvent> = {}) =>
  ({ type: 'text-delta', text: value, ...extra }) as RunStreamEvent;
const FINISH = { type: 'finish' } as RunStreamEvent;
const userRow = (seq: number, content: string) => message(seq, { id: `u${seq}`, role: 'user', bot_id: null, content });
const rows = (from: number, count: number) => Array.from({ length: count }, (_, i) => message(from + i));
const seqs = (messages: readonly BotMessage[]) => messages.map((m) => m.seq);
const runStarts = (effects: ThreadEffect[], runKey: string) =>
  effects.filter((e) => e.type === 'run-started' && e.runKey === runKey);

async function setup(
  o: {
    status?: RealtimeStatus;
    messages?: BotMessage[];
    visible?: boolean;
    storeApi?: Partial<BotsStoreDeps['api']>;
    prepare?: (fake: FakeThreadApi) => void;
    cache?: ThreadCache;
  } = {},
) {
  const time = new FakeClock();
  const rt = new FakeRealtime(time.clock.now, o.status ?? 'open');
  const fake = new FakeThreadApi(SID);
  fake.server.messages = o.messages ?? [message(0, { bot_event: { kind: 'greeting', bot_id: 'bot_a' } })];
  o.prepare?.(fake);
  const { store, calls } = makeStore(o.storeApi, time.clock);
  const engine = new ThreadEngine(
    SID,
    { api: fake.api, realtime: rt, store, clock: time.clock },
    { cache: o.cache ?? new ThreadCache() },
  );
  const effects: ThreadEffect[] = [];
  engine.onEffect((e) => effects.push(e));
  let renders = 0;
  engine.subscribe(() => {
    renders += 1;
  });
  if (o.visible !== false) engine.setVisible(true);
  await time.advance(0);
  return {
    time,
    rt,
    fake,
    store,
    calls,
    engine,
    effects,
    snap: () => engine.getSnapshot(),
    renders: () => renders,
    reloads: () => fake.calls.getConversation.filter((call) => call.beforeSeq === undefined).length,
  };
}

/** Start a run through a 200 POST; returns the stream the test feeds. */
async function startRun(t: Awaited<ReturnType<typeof setup>>, content = 'hi') {
  const stream = new FakeStream();
  t.fake.posts.push({ kind: 'stream', events: stream.events });
  const outcome = await t.engine.send({ text: content, images: [], mentions: [] });
  await t.time.advance(0);
  return { stream, outcome };
}

describe('opening', () => {
  it('loads the newest page; marks it read only while visible', async () => {
    const t = await setup({ visible: false });
    expect(t.snap().load).toBe('ready');
    expect(t.snap().messages.map((m) => m.seq)).toEqual([0]);
    expect(t.fake.calls.getConversation[0]).toEqual({ limit: 60 });
    expect(t.fake.calls.markRead).toBe(0);

    t.engine.setVisible(true);
    await t.time.advance(0);
    expect(t.fake.calls.markRead).toBe(1);
    expect(t.store.getState().visibleThread).toBe(SID);

    t.engine.setVisible(false);
    expect(t.store.getState().visibleThread).toBeNull();
  });

  it.each([
    ['reconnect', { type: 'resync' }],
    ['run completion', { type: 'chat:run', sessionId: SID, runId: 'r1', status: 'completed' }],
    ['run failure', { type: 'chat:run', sessionId: SID, runId: 'r1', status: 'error' }],
    ['conversation change', { type: 'bots:conversation', sessionId: SID }],
  ] satisfies Array<[string, RealtimeEvent]>)(
    'publishes the opening page before one queued %s catch-up, without dropping the catch-up',
    async (_name, event) => {
      const first = deferred<void>();
      const catchUp = deferred<void>();
      const t = await setup({ prepare: (fake) => (fake.conversationGate = first.promise) });
      expect(t.snap().load).toBe('loading');
      // Any reconnect GET is slower than the already pending opening page.
      t.fake.conversationGate = catchUp.promise;
      for (let i = 0; i < 3; i += 1) t.rt.emit(event);
      await t.time.advance(CONVERSATION_RELOAD_MS);

      // The initial GET is still useful; the catch-up is slower and must not hold it back.
      first.resolve();
      await t.time.advance(0);
      expect(t.snap().load).toBe('ready');
      expect(seqs(t.snap().messages)).toEqual([0]);
      expect(t.reloads()).toBe(2);

      t.fake.server.messages.push(message(1));
      catchUp.resolve();
      await t.time.advance(0);
      expect(seqs(t.snap().messages)).toEqual([0, 1]);
      expect(t.reloads()).toBe(2);
    },
  );

  it.each(['resync', 'running push'] as const)(
    'publishes the opening page before %s attaches to an active run, then resumes it',
    async (event) => {
      const first = deferred<void>();
      const catchUp = deferred<void>();
      const t = await setup({ prepare: (fake) => (fake.conversationGate = first.promise) });
      t.fake.conversationGate = catchUp.promise;
      t.fake.probe = live('r1');
      t.fake.attaches.push(
        new FakeStream([
          turnStart('bot_a', 'user', { seq: 0, replayed: true }),
          text('Already working', { seq: 1, replayed: true }),
        ]),
      );
      // The app-wide sync owns the busy mark; the opening page must not delay it.
      t.store.getState().setRunning(SID, 'r1');
      t.rt.emit(
        event === 'resync' ? { type: 'resync' } : { type: 'chat:run', sessionId: SID, runId: 'r1', status: 'running' },
      );
      await t.time.advance(0);
      expect(t.snap().runActive).toBe(true);

      first.resolve();
      await t.time.advance(0);
      expect(t.snap().load).toBe('ready');
      expect(seqs(t.snap().messages)).toEqual([0]);
      expect(t.fake.calls.attach).toEqual([-1]);
      await t.time.advance(40);
      expect(t.snap().run?.segments[0].text).toBe('Already working');

      t.fake.server.messages.push(message(1));
      catchUp.resolve();
      await t.time.advance(0);
      expect(seqs(t.snap().messages)).toEqual([0, 1]);
      expect(t.fake.calls.attach).toEqual([-1]);
      expect(t.snap().runActive).toBe(true);
    },
  );

  it('shows an initial failure and still runs the queued reconnect catch-up', async () => {
    const first = deferred<void>();
    const catchUp = deferred<void>();
    const t = await setup({ prepare: (fake) => (fake.conversationGate = first.promise) });
    t.rt.emit({ type: 'resync' });
    t.fake.conversationGate = catchUp.promise;
    t.fake.conversationFailure = 500;
    first.resolve();
    await t.time.advance(0);
    expect(t.snap().load).toBe('error');
    expect(t.reloads()).toBe(2);

    t.fake.conversationFailure = null;
    catchUp.resolve();
    await t.time.advance(0);
    expect(t.snap().load).toBe('ready');
    expect(seqs(t.snap().messages)).toEqual([0]);
  });

  it('keeps latest-answer-wins for overlapping reloads after opening', async () => {
    const t = await setup();
    const older = deferred<Awaited<ReturnType<FakeThreadApi['api']['getConversation']>>>();
    const newer = deferred<Awaited<ReturnType<FakeThreadApi['api']['getConversation']>>>();
    let calls = 0;
    t.fake.api.getConversation = () => (++calls === 1 ? older.promise : newer.promise);
    const first = t.engine.reload();
    const second = t.engine.reload();
    newer.resolve({ ok: true, value: page(SID, rows(0, 3)) });
    await second;
    older.resolve({ ok: true, value: page(SID, rows(0, 2)) });
    await first;
    await t.time.advance(0);
    expect(seqs(t.snap().messages)).toEqual([0, 1, 2]);
  });

  it('404 → not_found; 403 → forbidden and the Bots surfaces close', async () => {
    const gone = await setup({ prepare: (fake) => (fake.conversationFailure = 404) });
    expect(gone.snap().load).toBe('not_found');
    const refused = await setup({ prepare: (fake) => (fake.conversationFailure = 403) });
    expect(refused.snap().load).toBe('forbidden');
    expect(refused.store.getState().error).toBe('forbidden');
  });

  it('attaches to a run that is already going, replaying it at once', async () => {
    const replay = new FakeStream([
      turnStart('bot_a', 'user', { seq: 0, replayed: true }),
      text('Already half way through', { seq: 1, replayed: true }),
    ]);
    const t = await setup({
      prepare: (fake) => {
        fake.probe = live('r1');
        fake.attaches.push(replay);
      },
    });
    await t.time.advance(0);
    expect(t.fake.calls.attach).toEqual([-1]);
    // Replayed text is not typed out.
    await t.time.advance(40);
    expect(t.snap().run?.segments[0].text).toBe('Already half way through');
    expect(t.snap().run?.replaying).toBe(true);
    expect(t.effects).toContainEqual({ type: 'run-started', runKey: `${SID}:r1`, byMe: false });
    expect(t.effects).toContainEqual({ type: 'segment-start', botId: 'bot_a', replayed: true });
    expect(t.snap().runActive).toBe(true);
  });
});

describe('account and station generations', () => {
  it('drops a pending opening page and its queued catch-up as soon as the store resets', async () => {
    const cache = new ThreadCache();
    const first = deferred<void>();
    const t = await setup({ cache, prepare: (fake) => (fake.conversationGate = first.promise) });
    t.rt.emit({ type: 'resync' });
    const renders = t.renders();
    t.store.getState().reset();
    expect(t.engine.isDisposed).toBe(true);
    first.resolve();
    await t.time.advance(0);

    expect(t.renders()).toBe(renders);
    expect(t.snap().load).toBe('loading');
    expect(t.reloads()).toBe(1);
    expect(t.fake.calls.markRead).toBe(0);
    expect(cache.get(SID, t.store.getState().generation)).toBeNull();
  });

  it('never saves an old ready transcript under the new generation on reset or late unmount', async () => {
    const cache = new ThreadCache();
    const t = await setup({ cache });
    expect(cache.get(SID, 0)?.messages).toHaveLength(1);
    t.store.getState().reset();
    expect(t.engine.isDisposed).toBe(true);
    const generation = t.store.getState().generation;
    expect(cache.get(SID, generation)).toBeNull();

    const current = page(SID, [message(9)]);
    cache.put(SID, generation, {
      conversation: current.conversation,
      messages: current.messages,
      hasMore: false,
      memoryStates: {},
    });
    t.store.getState().setVisibleThread(SID);
    t.engine.dispose();
    expect(seqs(cache.get(SID, generation)?.messages ?? [])).toEqual([9]);
    expect(t.store.getState().visibleThread).toBe(SID);
  });

  it('drops a stale forbidden answer without closing Bots for the new account', async () => {
    const gate = deferred<void>();
    const t = await setup({ prepare: (fake) => (fake.conversationGate = gate.promise) });
    t.store.getState().reset();
    t.fake.conversationFailure = 403;
    gate.resolve();
    await t.time.advance(0);
    expect(t.store.getState().error).toBeNull();
    expect(t.snap().load).toBe('loading');
  });

  it('does no I/O if the identity changed between construction and the first subscription', async () => {
    const time = new FakeClock();
    const fake = new FakeThreadApi(SID);
    const rt = new FakeRealtime(time.clock.now);
    const { store } = makeStore({}, time.clock);
    const engine = new ThreadEngine(SID, { api: fake.api, realtime: rt, store, clock: time.clock });
    store.getState().reset();
    engine.subscribe(() => {});
    await time.advance(0);
    expect(engine.isDisposed).toBe(true);
    expect(fake.calls.getConversation).toEqual([]);
    expect(fake.calls.probe).toBe(0);
  });
});

describe('sending', () => {
  it('200: the POST stream is the run’s reader; the persisted rows replace it once it settles', async () => {
    const t = await setup();
    const { stream, outcome } = await startRun(t, 'hi');
    expect(outcome).toEqual({ ok: true, startedRun: true });
    expect(t.fake.calls.open[0]).toEqual({ content: 'hi', images: [], mentions: [] });
    expect(t.snap().pending.map((p) => p.status)).toEqual(['sent']);

    stream.push(turnStart('bot_a'), text('Hello there'));
    await t.time.advance(100);
    expect(t.snap().run?.segments[0]).toMatchObject({ text: 'Hello there', status: 'streaming' });
    expect(t.snap().runActive).toBe(true);

    t.fake.server.messages.push(userRow(1, 'hi'), message(2, { id: 'm2', content: 'Hello there' }));
    stream.push(turnEnd('bot_a', 'm2'), FINISH).end();
    await t.time.advance(500);
    expect(t.snap().run).toBeNull();
    expect(t.snap().runActive).toBe(false);
    expect(t.snap().pending).toEqual([]);
    expect(t.snap().messages.map((m) => m.id)).toEqual(['m0', 'u1', 'm2']);
    expect(t.effects.map((e) => e.type)).toEqual(['run-started', 'segment-start', 'run-settled']);
    expect(t.effects[0]).toMatchObject({ byMe: true });
    expect(t.fake.calls.attach).toEqual([]);
  });

  it('202: delivered while busy — queued where it was sent, the run attached once', async () => {
    const t = await setup();
    const gate = deferred<void>();
    t.fake.probeGate = gate.promise;
    t.fake.probe = live('r9');
    const replay = new FakeStream();
    t.fake.attaches.push(replay);
    t.fake.posts.push({ kind: 'queued' });

    const sending = t.engine.send({ text: 'also this', images: [], mentions: [] });
    await t.time.advance(0);
    // The socket announces the same run while the probe is in flight: one attach, not two.
    t.rt.emit({ type: 'chat:run', sessionId: SID, runId: 'r9', status: 'running' });
    await t.time.advance(0);
    gate.resolve();
    expect(await sending).toEqual({ ok: true, startedRun: false });
    await t.time.advance(0);
    t.rt.emit({ type: 'chat:run', sessionId: SID, runId: 'r9', status: 'running' });
    await t.time.advance(0);

    expect(t.fake.calls.attach).toEqual([-1]);
    expect(t.snap().pending.map((p) => p.status)).toEqual(['queued']);
    expect(t.snap().remoteBusy).toBe(false);
  });

  it('409 bot_archived → read-only at once: bubble gone, directory and transcript re-read', async () => {
    const t = await setup();
    const listBots = t.calls.listBots;
    t.fake.posts.push({ kind: 'error', status: 409, code: 'bot_archived', message: 'archived' });
    const reloads = t.reloads();
    expect(await t.engine.send({ text: 'hello?', images: [], mentions: [] })).toEqual({
      ok: false,
      kind: 'read_only',
      code: 'bot_archived',
    });
    await t.time.advance(0);
    expect(t.snap().readOnly).toBe('bot_archived');
    expect(t.snap().pending).toEqual([]);
    expect(t.calls.listBots).toBe(listBots + 1);
    expect(t.reloads()).toBe(reloads + 1);
  });

  it('a refusal with any other code → rejected (the screen restores the draft)', async () => {
    const t = await setup();
    t.fake.posts.push({ kind: 'error', status: 409, code: 'something_else', message: 'nope' });
    t.fake.posts.push({ kind: 'error', status: 400, code: null, message: 'bad' });
    expect(await t.engine.send({ text: 'a', images: [], mentions: [] })).toEqual({
      ok: false,
      kind: 'rejected',
      status: 409,
      message: 'nope',
    });
    expect(await t.engine.send({ text: 'b', images: [], mentions: [] })).toMatchObject({
      kind: 'rejected',
      status: 400,
    });
    await t.time.advance(0);
    expect(t.snap().pending).toEqual([]);
    expect(t.snap().readOnly).toBeNull();
  });

  it('no answer → "Not Delivered" kept; retry re-reads first and never sends twice', async () => {
    const t = await setup();
    t.fake.posts.push({ kind: 'error', status: 0, code: null, message: '' });
    expect(await t.engine.send({ text: 'hello', images: [], mentions: ['bot_a'] })).toEqual({
      ok: false,
      kind: 'not_delivered',
    });
    await t.time.advance(0);
    const [failed] = t.snap().pending;
    expect(failed).toMatchObject({ status: 'sending', failed: true });

    // The server had it after all (only the answer was lost).
    t.fake.server.messages.push(userRow(1, 'hello'));
    expect(await t.engine.retry(failed.clientId)).toEqual({ ok: true, startedRun: false });
    await t.time.advance(0);
    expect(t.fake.calls.open).toHaveLength(1);
    expect(t.snap().pending).toEqual([]);
  });

  it('retry resends the same bubble (same id and place) when the server never got it; not when it cannot tell', async () => {
    const t = await setup();
    t.fake.posts.push({ kind: 'error', status: 0, code: null, message: '' });
    await t.engine.send({ text: 'ping', images: [], mentions: ['bot_b'] });
    await t.time.advance(0);
    const [failed] = t.snap().pending;

    t.fake.conversationFailure = 500;
    expect(await t.engine.retry(failed.clientId)).toEqual({ ok: false, kind: 'not_delivered' });
    expect(t.fake.calls.open).toHaveLength(1);

    t.fake.conversationFailure = null;
    t.fake.posts.push({ kind: 'queued' });
    expect(await t.engine.retry(failed.clientId)).toEqual({ ok: true, startedRun: false });
    await t.time.advance(0);
    expect(t.fake.calls.open).toHaveLength(2);
    expect(t.fake.calls.open[1]).toEqual({ content: 'ping', images: [], mentions: ['bot_b'] });
    expect(t.snap().pending).toEqual([
      expect.objectContaining({ clientId: failed.clientId, status: 'queued', failed: false }),
    ]);

    t.engine.discard(failed.clientId);
    await t.time.advance(0);
    expect(t.snap().pending).toEqual([]);
  });
});

describe('settling sends', () => {
  it('matches persisted copies one-to-one, oldest first (two identical sends, one persisted)', async () => {
    const t = await setup();
    t.fake.posts.push({ kind: 'queued' }, { kind: 'queued' });
    await t.engine.send({ text: 'ok', images: [], mentions: [] });
    await t.engine.send({ text: 'ok ', images: [], mentions: [] });
    await t.time.advance(0);
    const [older, newer] = t.snap().pending;
    t.fake.server.messages.push(userRow(1, 'ok'));
    await t.engine.reload();
    expect(t.snap().pending.map((p) => p.clientId)).toEqual([newer.clientId]);
    expect(older.clientId).not.toBe(newer.clientId);
  });

  it('an identical row from before the send never settles it', async () => {
    const t = await setup({ messages: [userRow(0, 'ok')] });
    t.fake.posts.push({ kind: 'queued' });
    await t.engine.send({ text: 'ok', images: [], mentions: [] });
    await t.engine.reload();
    expect(t.snap().pending).toHaveLength(1);
  });

  it('no answer, but the run was announced meanwhile: the server took it — attach and read it', async () => {
    const t = await setup();
    const post = deferred<BotsPost>();
    t.fake.posts.push(post.promise);
    const sending = t.engine.send({ text: 'hi', images: [], mentions: [] });
    await t.time.advance(0);
    t.rt.emit({ type: 'chat:run', sessionId: SID, runId: 'r7', status: 'running' });
    t.fake.probe = live('r7');
    t.fake.attaches.push(new FakeStream([turnStart('bot_a', 'user', { replayed: true })]));
    post.resolve({ kind: 'error', status: 0, code: null, message: '' });
    expect(await sending).toEqual({ ok: false, kind: 'not_delivered' });
    await t.time.advance(100);
    expect(t.fake.calls.attach).toEqual([-1]);
    expect(t.effects).toContainEqual({ type: 'run-started', runKey: `${SID}:r7`, byMe: false });
  });
});

describe('one reader at a time', () => {
  it('a new run’s 200 stream waits until the previous reader has settled', async () => {
    const t = await setup();
    const first = await startRun(t, 'one');
    first.stream.push(turnStart('bot_a'), text('First'), turnEnd('bot_a', 'm2'));
    await t.time.advance(100);

    // The settle reload of the first run is held open.
    const gate = deferred<void>();
    t.fake.conversationGate = gate.promise;
    t.fake.server.messages.push(userRow(1, 'one'), message(2, { id: 'm2', content: 'First' }));
    first.stream.push(FINISH).end();
    await t.time.advance(100);

    const second = new FakeStream([turnStart('bot_a'), text('Second')]);
    t.fake.posts.push({ kind: 'stream', events: second.events });
    expect(await t.engine.send({ text: 'two', images: [], mentions: [] })).toEqual({ ok: true, startedRun: true });
    await t.time.advance(100);
    expect(second.opened).toBe(false);
    expect(t.snap().run?.segments[0].text).toBe('First');

    gate.resolve();
    t.fake.conversationGate = null;
    await t.time.advance(100);
    expect(second.opened).toBe(true);
    expect(t.snap().run?.segments.map((s) => s.text)).toEqual(['Second']);
    expect(t.effects.filter((e) => e.type === 'run-started')).toHaveLength(2);
  });

  it('chat:run arriving before the POST’s 200 is latched — no second reader', async () => {
    const t = await setup();
    const post = deferred<BotsPost>();
    t.fake.posts.push(post.promise);
    const sending = t.engine.send({ text: 'hi', images: [], mentions: [] });
    await t.time.advance(0);
    t.rt.emit({ type: 'chat:run', sessionId: SID, runId: 'r1', status: 'running' });
    await t.time.advance(0);
    const probes = t.fake.calls.probe;

    const stream = new FakeStream([turnStart('bot_a'), text('Hi!'), turnEnd('bot_a', 'm2'), FINISH]);
    post.resolve({ kind: 'stream', events: stream.events });
    await sending;
    stream.end();
    await t.time.advance(500);

    expect(t.fake.calls.attach).toEqual([]);
    // The latch named the run: no probe was needed to learn its id.
    expect(t.fake.calls.probe).toBe(probes);
    expect(t.effects).toContainEqual({ type: 'run-started', runKey: `${SID}:r1`, byMe: true });
  });

  it('a push for the run being read is ignored', async () => {
    const t = await setup();
    t.fake.probe = live('r1');
    const { stream } = await startRun(t);
    stream.push(turnStart('bot_a'));
    await t.time.advance(0);
    t.rt.emit({ type: 'chat:run', sessionId: SID, runId: 'r1', status: 'running' });
    await t.time.advance(100);
    expect(t.fake.calls.attach).toEqual([]);
  });
});

describe('resuming', () => {
  it('same run: resumes after the last seq; after 5 failed re-attaches in a row it lets go and reloads — the busy mark stays while the run goes on', async () => {
    const t = await setup();
    t.fake.probe = live('r1');
    const { stream } = await startRun(t);
    stream.push(turnStart('bot_a', 'user', { seq: 0 }), text('partial', { seq: 1 }));
    await t.time.advance(100);
    for (let i = 0; i < MAX_RESUMES; i += 1) t.fake.attaches.push(new FakeStream().fail());
    const reloads = t.reloads();

    stream.fail();
    await t.time.advance(20_000);
    expect(t.fake.calls.attach).toEqual([1, 1, 1, 1, 1]);
    expect(t.snap().run).toBeNull();
    expect(t.reloads()).toBeGreaterThan(reloads);
    expect(t.snap().runError).toBeNull();
    // The last look found it still running: "Working…" and Stop stay; a push, resync or poll picks it up.
    expect(t.store.getState().running[SID]).toBe('r1');
    expect(t.snap().runActive).toBe(true);
  });

  it('another run in the slot: the old one settles, the new one is read from its start', async () => {
    const t = await setup();
    t.fake.probe = live('r1');
    const { stream } = await startRun(t);
    stream.push(turnStart('bot_a', 'user', { seq: 0 }), text('partial', { seq: 1 }));
    await t.time.advance(100);

    t.fake.probe = live('r2');
    const next = new FakeStream([
      turnStart('bot_b', 'user', { seq: 0, replayed: true }),
      text('A new run', { seq: 1, replayed: true }),
    ]);
    t.fake.attaches.push(next);
    stream.fail();
    await t.time.advance(1_000);

    expect(t.fake.calls.attach).toEqual([-1]);
    const types = t.effects.map((e) => e.type);
    expect(types.indexOf('run-settled')).toBeGreaterThan(-1);
    expect(t.effects).toContainEqual({ type: 'run-started', runKey: `${SID}:r2`, byMe: false });
    expect(t.snap().run?.segments.map((s) => [s.botId, s.text])).toEqual([['bot_b', 'A new run']]);
  });

  it('an unanswered probe keeps what is on screen and asks again', async () => {
    const t = await setup();
    t.fake.probe = live('r1');
    const { stream } = await startRun(t);
    stream.push(turnStart('bot_a', 'user', { seq: 0 }), text('kept', { seq: 1 }));
    await t.time.advance(100);
    t.fake.probe = null;
    stream.fail();
    await t.time.advance(900);
    expect(t.snap().run?.segments[0].text).toBe('kept');
    expect(t.fake.calls.attach).toEqual([]);

    t.fake.probe = live('r1');
    t.fake.attaches.push(new FakeStream([text(' and more', { seq: 2 }), turnEnd('bot_a', 'm9', { seq: 3 })]));
    await t.time.advance(2_000);
    expect(t.fake.calls.attach).toEqual([1]);
    expect(t.snap().run?.segments[0].text).toBe('kept and more');
  });

  it('back in the foreground after a silent stretch: the dead socket is dropped and resumed', async () => {
    const t = await setup();
    t.fake.probe = live('r1');
    const { stream } = await startRun(t);
    stream.push(turnStart('bot_a', 'user', { seq: 4 }));
    await t.time.advance(0);
    t.engine.setForeground(false);
    await t.time.advance(STALE_MS + 1);
    t.fake.attaches.push(new FakeStream([text('back', { seq: 5 })]));
    t.engine.setForeground(true);
    await t.time.advance(1_000);
    expect(t.fake.calls.attach).toEqual([4]);
    expect(t.snap().run?.segments[0].text).toBe('back');
  });

  it('a server-declared error is read to the end, never retried, and reported', async () => {
    const t = await setup();
    t.fake.probe = live('r1');
    const { stream } = await startRun(t);
    stream
      .push(turnStart('bot_a'), text('so far'), { type: 'error', error: 'model overloaded' } as RunStreamEvent)
      .end();
    await t.time.advance(1_000);
    expect(t.fake.calls.attach).toEqual([]);
    expect(t.snap().runError).toBe('model overloaded');
    t.engine.dismissRunError();
    await t.time.advance(0);
    expect(t.snap().runError).toBeNull();
  });
});

describe('stopping', () => {
  it('first tap = soft; a turn that starts meanwhile used the request up; second tap = hard', async () => {
    const t = await setup();
    const { stream } = await startRun(t);
    stream.push(turnStart('bot_a'));
    await t.time.advance(0);
    expect(t.snap().stopPhase).toBeNull();

    const answer = deferred<'interrupting'>();
    t.fake.interrupt.push(answer.promise);
    t.engine.stop('next');
    await t.time.advance(0);
    expect(t.snap().stopPhase).toBe('soft'); // shown while the request is in flight

    stream.push(turnEnd('bot_a', 'm1'), turnStart('bot_a', 'interjection'));
    await t.time.advance(0);
    answer.resolve('interrupting');
    await t.time.advance(0);
    expect(t.snap().run?.interrupting).toBe(false);
    expect(t.snap().stopPhase).toBeNull();

    t.engine.stop('next');
    await t.time.advance(0);
    expect(t.snap().run?.interrupting).toBe(true);
    expect(t.snap().stopPhase).toBe('soft');

    t.engine.stop('next');
    await t.time.advance(0);
    expect(t.fake.calls.stop).toBe(1);
    expect(t.snap().stopPhase).toBe('hard');

    stream.push(FINISH).end();
    await t.time.advance(500);
    expect(t.snap().stopPhase).toBeNull();
    expect(t.snap().runActive).toBe(false);
    expect(t.snap().runError).toBeNull();
  });

  it('the stream’s own run-interrupting (another device) shows soft; the next turn clears it', async () => {
    const t = await setup();
    const { stream } = await startRun(t);
    stream.push(turnStart('bot_a'), { type: 'run-interrupting' } as RunStreamEvent);
    await t.time.advance(0);
    expect(t.snap().stopPhase).toBe('soft');
    stream.push(turnEnd('bot_a', 'm1'), turnStart('bot_a', 'interjection'));
    await t.time.advance(0);
    expect(t.snap().stopPhase).toBeNull();
  });

  it('no_run → let go quietly; refused → stop now', async () => {
    const quiet = await setup();
    const one = await startRun(quiet);
    one.stream.push(turnStart('bot_a'), text('almost'));
    await quiet.time.advance(100);
    quiet.fake.interrupt.push('no_run');
    quiet.engine.stop();
    await quiet.time.advance(100);
    expect(quiet.fake.calls.stop).toBe(0);
    expect(quiet.snap().run).toBeNull();
    expect(quiet.snap().runActive).toBe(false);
    expect(quiet.snap().runError).toBeNull();

    const hard = await setup();
    const two = await startRun(hard);
    two.stream.push(turnStart('bot_a'));
    await hard.time.advance(0);
    hard.fake.interrupt.push('refused');
    hard.engine.stop();
    await hard.time.advance(0);
    expect(hard.fake.calls.stop).toBe(1);
    expect(hard.snap().stopPhase).toBe('hard');
  });

  it('a hard stop the server never heard: let go locally, the open turn shown as stopped, no error', async () => {
    const t = await setup();
    const { stream } = await startRun(t);
    stream.push(turnStart('bot_a'), text('cut short'));
    await t.time.advance(100);
    t.fake.stopOk = false;
    // Hold the settle reload to look at the run as it winds down.
    const gate = deferred<void>();
    t.fake.conversationGate = gate.promise;
    t.engine.stop('hard');
    await t.time.advance(100);
    expect(t.snap().run?.segments[0].status).toBe('stopped');
    gate.resolve();
    await t.time.advance(100);
    expect(t.snap().run).toBeNull();
    expect(t.snap().runError).toBeNull();
    expect(t.snap().stopPhase).toBeNull();
  });

  it('Stop does nothing when no run is active', async () => {
    const t = await setup();
    t.engine.stop();
    await t.time.advance(0);
    expect(t.fake.calls.interrupt).toBe(0);
    expect(t.fake.calls.stop).toBe(0);
  });
});

describe('queued messages', () => {
  it('Handle Now nudges; a refusal takes it back', async () => {
    const t = await setup();
    t.fake.posts.push({ kind: 'queued' }, { kind: 'queued' });
    await t.engine.send({ text: 'a', images: [], mentions: [] });
    await t.engine.send({ text: 'b', images: [], mentions: [] });
    await t.time.advance(0);
    const [a, b] = t.snap().pending;

    t.fake.interrupt.push('interrupting');
    expect(await t.engine.handleNow(a.clientId)).toBe('ok');
    t.fake.interrupt.push('refused');
    expect(await t.engine.handleNow(b.clientId)).toBe('refused');
    await t.time.advance(0);
    expect(t.snap().pending.map((p) => p.nudged)).toEqual([true, false]);
  });

  it('each interjection turn picks up one queued message, once — even when the run is read again', async () => {
    const t = await setup({ prepare: (fake) => (fake.probe = { active: false }) });
    const { stream } = await startRun(t, 'start');
    stream.push(turnStart('bot_a', 'user', { seq: 0 }), text('working', { seq: 1 }));
    await t.time.advance(100);
    t.fake.posts.push({ kind: 'queued' }, { kind: 'queued' });
    await t.engine.send({ text: 'first', images: [], mentions: [] });
    await t.engine.send({ text: 'second', images: [], mentions: [] });
    await t.time.advance(0);
    expect(t.snap().pending.map((p) => [p.content, p.status, p.afterSegment])).toEqual([
      ['start', 'sent', 0],
      ['first', 'queued', 1],
      ['second', 'queued', 1],
    ]);

    stream.push(turnEnd('bot_a', 'm2', { seq: 2 }), turnStart('bot_a', 'interjection', { seq: 3 }));
    await t.time.advance(0);
    expect(t.snap().pending.map((p) => p.status)).toEqual(['sent', 'sent', 'queued']);

    // The transport drops; this POST never learned its run id — the run is read again from its start.
    t.fake.probe = live('r1');
    t.fake.attaches.push(
      new FakeStream([
        turnStart('bot_a', 'user', { seq: 0, replayed: true }),
        turnEnd('bot_a', 'm2', { seq: 2, replayed: true }),
        turnStart('bot_a', 'interjection', { seq: 3, replayed: true }),
      ]),
    );
    stream.fail();
    await t.time.advance(1_000);
    expect(t.fake.calls.attach).toEqual([-1]);
    expect(t.snap().pending.find((p) => p.content === 'second')).toMatchObject({ status: 'queued', afterSegment: 1 });
  });

  it('a queued message nobody here can attach to: static busy, reloads at 3 s then every 5 s, for 60 s at most', async () => {
    const t = await setup();
    t.fake.posts.push({ kind: 'queued' });
    await t.engine.send({ text: 'later', images: [], mentions: [] });
    await t.time.advance(0);
    expect(t.snap().remoteBusy).toBe(true);
    expect(t.snap().runActive).toBe(true);
    expect(t.snap().run).toBeNull();

    const start = t.reloads();
    await t.time.advance(REMOTE_BUSY_FIRST_MS - 1);
    expect(t.reloads()).toBe(start);
    await t.time.advance(1);
    expect(t.reloads()).toBe(start + 1);
    await t.time.advance(5_000);
    expect(t.reloads()).toBe(start + 2);
    await t.time.advance(REMOTE_BUSY_MAX_MS);
    const capped = t.reloads();
    expect(capped).toBe(start + 12); // 3, 8, …, 58 s
    expect(t.snap().remoteBusy).toBe(false);
    await t.time.advance(30_000);
    expect(t.reloads()).toBe(capped);
  });

  it('remote busy ends as soon as the message is in the transcript', async () => {
    const t = await setup();
    t.fake.posts.push({ kind: 'queued' });
    await t.engine.send({ text: 'later', images: [], mentions: [] });
    await t.time.advance(0);
    t.fake.server.messages.push(userRow(1, 'later'));
    await t.time.advance(REMOTE_BUSY_FIRST_MS);
    expect(t.snap().remoteBusy).toBe(false);
    expect(t.snap().pending).toEqual([]);
    expect(t.snap().runActive).toBe(false);
  });
});

describe('typing out', () => {
  it('only the first segment with a backlog types; the next waits at 0 characters', async () => {
    const t = await setup();
    const { stream } = await startRun(t);
    const long = 'word '.repeat(40);
    stream.push(turnStart('bot_a'), text(long), turnEnd('bot_a', 'mA'), turnStart('bot_b', 'ask'), text('Second Bot'));
    await t.time.advance(33);
    const run = t.snap().run;
    expect(run?.revealing).toBe(0);
    expect(run?.segments[0].text.length).toBeLessThan(long.length);
    expect(run?.segments[0].status).toBe('streaming'); // ended, still being typed
    expect(run?.segments[1].text).toBe('');
    await t.time.advance(3_000);
    expect(t.snap().run?.segments.map((s) => s.text)).toEqual([long, 'Second Bot']);
    expect(t.snap().run?.segments[0].status).toBe('completed');
  });

  it('unchanged segments keep their objects from one snapshot to the next', async () => {
    const t = await setup();
    const { stream } = await startRun(t);
    stream.push(turnStart('bot_a'), text('Done.'), turnEnd('bot_a', 'mA'), turnStart('bot_b', 'ask'));
    await t.time.advance(200);
    const before = t.snap().run?.segments[0];
    stream.push(text('Typing now'));
    await t.time.advance(200);
    expect(t.snap().run?.segments[0]).toBe(before);
    expect(t.snap().run?.segments[1].text).toBe('Typing now');
  });
});

describe('cards', () => {
  it('a decision is remembered (only forward) and probes for the run it starts', async () => {
    const card = request('brq_1', { session_id: SID });
    const t = await setup({
      storeApi: { decideRequest: async () => ({ ok: true as const, value: { ...card, status: 'resolved' as const } }) },
    });
    const { stream } = await startRun(t);
    stream.push(turnStart('bot_a'), { type: 'bot-request', request: card } as RunStreamEvent);
    await t.time.advance(0);
    expect(t.effects).toContainEqual({ type: 'request-arrived', request: card, replayed: false });
    expect(t.snap().requests.get('brq_1')?.status).toBe('pending');

    t.fake.server.messages.push(userRow(1, 'hi'));
    stream.push(turnEnd('bot_a', 'mA'), FINISH).end();
    await t.time.advance(300);
    const probes = t.fake.calls.probe;
    expect(await t.engine.decide(card, { decision: 'approve' })).toMatchObject({ kind: 'ok' });
    await t.time.advance(0);
    expect(t.snap().requests.get('brq_1')?.status).toBe('resolved');
    t.fake.probe = live('r5');
    t.fake.attaches.push(new FakeStream());
    await t.time.advance(DECIDE_PROBE_MS);
    expect(t.fake.calls.probe).toBe(probes + 1);
    expect(t.fake.calls.attach).toEqual([-1]);
  });

  it('a card of this thread decided in a sheet (the store) → the same one probe', async () => {
    const card = request('brq_3', { session_id: SID });
    const other = request('brq_4', { session_id: 'elsewhere' });
    const t = await setup({
      storeApi: {
        decideRequest: async (id: string) => ({
          ok: true as const,
          value: { ...(id === card.id ? card : other), status: 'resolved' as const },
        }),
      },
    });
    const probes = t.fake.calls.probe;
    await t.store.getState().decide(other, { decision: 'approve' });
    await t.time.advance(DECIDE_PROBE_MS);
    expect(t.fake.calls.probe).toBe(probes);

    await t.store.getState().decide(card, { decision: 'approve' });
    await t.store.getState().decide(card, { decision: 'approve' });
    await t.time.advance(DECIDE_PROBE_MS);
    expect(t.fake.calls.probe).toBe(probes + 1);
  });

  it('settled elsewhere (stale) → re-read quietly', async () => {
    const card: BotRequestView = request('brq_2', { session_id: SID });
    const t = await setup({
      storeApi: {
        decideRequest: async () => ({ ok: false as const, status: 409, code: 'already_decided', message: '' }),
      },
    });
    const reloads = t.reloads();
    expect(await t.engine.decide(card, { decision: 'deny' })).toEqual({ kind: 'stale' });
    await t.time.advance(0);
    expect(t.reloads()).toBe(reloads + 1);
  });
});

describe('pushes', () => {
  it('bots:conversation for this thread → one reload per burst (250 ms), read while visible', async () => {
    const t = await setup();
    const reloads = t.reloads();
    const reads = t.fake.calls.markRead;
    for (let i = 0; i < 3; i += 1) {
      t.rt.emit({ type: 'bots:conversation', sessionId: SID });
      await t.time.advance(100);
    }
    t.rt.emit({ type: 'bots:conversation', sessionId: 'other' });
    await t.time.advance(CONVERSATION_RELOAD_MS);
    expect(t.reloads()).toBe(reloads + 1);
    expect(t.fake.calls.markRead).toBe(reads + 1);
  });

  it('read receipts only while visible and in the foreground', async () => {
    const t = await setup({ visible: false });
    t.rt.emit({ type: 'bots:conversation', sessionId: SID });
    await t.time.advance(CONVERSATION_RELOAD_MS);
    expect(t.fake.calls.markRead).toBe(0);
    t.engine.setVisible(true);
    await t.time.advance(0);
    expect(t.fake.calls.markRead).toBe(1);
    t.engine.setForeground(false);
    t.rt.emit({ type: 'bots:conversation', sessionId: SID });
    await t.time.advance(CONVERSATION_RELOAD_MS);
    expect(t.fake.calls.markRead).toBe(1);
  });

  it('a run that ended with nobody here reading it → reload', async () => {
    const t = await setup();
    const reloads = t.reloads();
    t.rt.emit({ type: 'chat:run', sessionId: SID, runId: 'r3', status: 'completed' });
    await t.time.advance(0);
    expect(t.reloads()).toBe(reloads + 1);
  });

  it('a run the server started by itself is attached (single flight)', async () => {
    const t = await setup();
    t.fake.probe = live('r4');
    t.fake.attaches.push(new FakeStream([turnStart('bot_a', 'user', { replayed: true })]));
    t.rt.emit({ type: 'chat:run', sessionId: SID, runId: 'r4', status: 'running' });
    t.rt.emit({ type: 'resync' });
    await t.time.advance(100);
    expect(t.fake.calls.attach).toEqual([-1]);
    expect(t.effects).toContainEqual({ type: 'run-started', runKey: `${SID}:r4`, byMe: false });
  });
});

describe('polling fallback', () => {
  it('none while the socket is open; probes every 8 s and reloads every 24 s once it has been down 10 s', async () => {
    const t = await setup();
    const probes = t.fake.calls.probe;
    const reloads = t.reloads();
    await t.time.advance(120_000);
    expect(t.fake.calls.probe).toBe(probes);
    expect(t.reloads()).toBe(reloads);

    t.rt.setStatus('backoff');
    await t.time.advance(POLL_GRACE_MS - 1);
    expect(t.fake.calls.probe).toBe(probes);
    await t.time.advance(1);
    expect(t.fake.calls.probe).toBe(probes + 1);
    await t.time.advance(POLL_PROBE_MS * 2);
    expect(t.fake.calls.probe).toBe(probes + 3);
    expect(t.reloads()).toBe(reloads + 1); // the 3rd beat

    t.rt.setStatus('open');
    await t.time.advance(120_000);
    expect(t.fake.calls.probe).toBe(probes + 3);
  });

  it('never while the thread is not visible', async () => {
    const t = await setup({ status: 'backoff', visible: false });
    const probes = t.fake.calls.probe;
    await t.time.advance(60_000);
    expect(t.fake.calls.probe).toBe(probes);
  });
});

describe('paging & lifecycle', () => {
  it('loads earlier pages in front; the newest page’s has_more no longer speaks once paged up', async () => {
    const all = Array.from({ length: 130 }, (_, i) => message(i));
    const t = await setup({ messages: all });
    expect(t.snap().messages).toHaveLength(60);
    expect(t.snap().hasMore).toBe(true);
    await t.engine.loadEarlier();
    expect(t.fake.calls.getConversation.at(-1)).toEqual({ beforeSeq: 70, limit: 60 });
    expect(t.snap().messages.map((m) => m.seq)[0]).toBe(10);
    expect(t.snap().hasMore).toBe(true);
    await t.engine.reload();
    expect(t.snap().messages).toHaveLength(120);
    expect(t.snap().hasMore).toBe(true);
  });

  it('a failed page of earlier messages is reported, and can be tried again', async () => {
    const t = await setup({ messages: Array.from({ length: 70 }, (_, i) => message(i)) });
    t.fake.conversationFailure = 500;
    await t.engine.loadEarlier();
    expect(t.snap().earlier).toBe('error');
    t.fake.conversationFailure = null;
    await t.engine.loadEarlier();
    expect(t.snap().earlier).toBe('idle');
    expect(t.snap().messages).toHaveLength(70);
    expect(t.snap().hasMore).toBe(false);
  });

  it('a reload that changes nothing keeps the message objects (rows stay memoised)', async () => {
    const t = await setup();
    const before = t.snap().messages;
    await t.engine.reload();
    expect(t.snap().messages).toBe(before);
  });

  it('dispose lets go of the stream locally and forgets the visible thread', async () => {
    const t = await setup();
    const { stream } = await startRun(t);
    stream.push(turnStart('bot_a'));
    await t.time.advance(0);
    t.engine.dispose();
    stream.push(text('after'));
    await t.time.advance(100);
    expect(t.store.getState().visibleThread).toBeNull();
    expect(t.fake.calls.stop).toBe(0);
    expect(t.engine.getSnapshot().run?.segments[0].text).toBe('');
  });
});

describe('the newest page after a long absence', () => {
  it('more than a page landed since the last load: the newest page replaces what is loaded — no hole', async () => {
    const t = await setup({ messages: rows(0, 40) });
    expect(t.snap().hasMore).toBe(false);
    // 150 rows land while the app is in the background (a busy group, another device).
    t.engine.setForeground(false);
    t.fake.server.messages.push(...rows(40, 150));
    t.engine.setForeground(true);
    await t.time.advance(0);
    expect(seqs(t.snap().messages)).toEqual(seqs(rows(130, 60)));
    expect(t.snap().hasMore).toBe(true);
    // Paging up fills in from there, without a gap.
    await t.engine.loadEarlier();
    expect(seqs(t.snap().messages)).toEqual(seqs(rows(70, 120)));
  });

  it('reopened from the cache after a long absence: the hole is neither shown nor cached', async () => {
    const cache = new ThreadCache();
    const first = await setup({ messages: rows(0, 40), cache });
    first.engine.dispose();
    const second = await setup({ cache, prepare: (fake) => (fake.server.messages = rows(0, 190)) });
    expect(seqs(second.snap().messages)).toEqual(seqs(rows(130, 60)));
    expect(second.snap().hasMore).toBe(true);
    expect(seqs(cache.get(SID, 0)?.messages ?? [])).toEqual(seqs(rows(130, 60)));
  });

  it('an earlier page that lands after such a reset is dropped (it would sit below a hole)', async () => {
    const t = await setup({ messages: rows(0, 130) });
    expect(seqs(t.snap().messages)).toEqual(seqs(rows(70, 60)));
    const gate = deferred<void>();
    t.fake.conversationGate = gate.promise;
    t.fake.server.messages.push(...rows(130, 150));
    const reloading = t.engine.reload();
    const paging = t.engine.loadEarlier();
    t.fake.conversationGate = null;
    gate.resolve();
    await Promise.all([reloading, paging]);
    expect(seqs(t.snap().messages)).toEqual(seqs(rows(220, 60)));
    expect(t.snap().earlier).toBe('idle');
    await t.engine.loadEarlier();
    expect(seqs(t.snap().messages)).toEqual(seqs(rows(160, 120)));
  });

  it('a newest page that meets what is loaded is merged (the history scrolled to is kept)', async () => {
    const t = await setup({ messages: rows(0, 40) });
    t.fake.server.messages.push(...rows(40, 60));
    await t.engine.reload();
    expect(seqs(t.snap().messages)).toEqual(seqs(rows(0, 100)));
  });
});

describe('retrying while a run is going', () => {
  it('a lost 202: the message may wait in the run’s inbox — Try Again does not send it again', async () => {
    const t = await setup();
    t.fake.posts.push({ kind: 'error', status: 0, code: null, message: '' });
    await t.engine.send({ text: 'also this', images: [], mentions: [] });
    await t.time.advance(0);
    const [failed] = t.snap().pending;

    t.fake.probe = live('r1');
    const run = new FakeStream([turnStart('bot_a', 'user', { seq: 0, replayed: true })]);
    t.fake.attaches.push(run);
    expect(await t.engine.retry(failed.clientId)).toEqual({ ok: true, startedRun: false });
    await t.time.advance(0);
    expect(t.fake.calls.open).toHaveLength(1);
    expect(t.fake.calls.attach).toEqual([-1]);
    expect(t.snap().pending).toEqual([
      expect.objectContaining({ clientId: failed.clientId, status: 'queued', failed: false }),
    ]);

    // The next turn boundary drains the inbox: the copy is persisted and the bubble settles.
    t.fake.server.messages.push(userRow(1, 'also this'));
    t.fake.probe = { active: false };
    run.push(turnEnd('bot_a', 'm9', { seq: 1 }), turnStart('bot_a', 'interjection', { seq: 2 }), FINISH).end();
    await t.time.advance(1_000);
    expect(t.snap().pending).toEqual([]);
    expect(t.fake.calls.open).toHaveLength(1);
  });

  it('the run ends and the message is still not there: Try Again comes back, and then it is sent', async () => {
    const t = await setup();
    t.fake.posts.push({ kind: 'error', status: 0, code: null, message: '' });
    await t.engine.send({ text: 'ping', images: [], mentions: [] });
    await t.time.advance(0);
    const [failed] = t.snap().pending;
    t.fake.probe = live('r1');
    const run = new FakeStream([turnStart('bot_a', 'user', { seq: 0, replayed: true })]);
    t.fake.attaches.push(run);
    await t.engine.retry(failed.clientId);
    await t.time.advance(0);

    t.fake.probe = { active: false };
    run.push(FINISH).end();
    await t.time.advance(1_000);
    expect(t.snap().pending).toEqual([
      expect.objectContaining({ clientId: failed.clientId, status: 'sending', failed: true }),
    ]);

    t.fake.posts.push({ kind: 'queued' });
    expect(await t.engine.retry(failed.clientId)).toEqual({ ok: true, startedRun: false });
    expect(t.fake.calls.open).toHaveLength(2);
  });

  it('a retry that cannot ask whether a run is going sends nothing', async () => {
    const t = await setup();
    t.fake.posts.push({ kind: 'error', status: 0, code: null, message: '' });
    await t.engine.send({ text: 'ping', images: [], mentions: [] });
    await t.time.advance(0);
    const [failed] = t.snap().pending;
    t.fake.probe = null;
    expect(await t.engine.retry(failed.clientId)).toEqual({ ok: false, kind: 'not_delivered' });
    expect(t.fake.calls.open).toHaveLength(1);
    expect(t.snap().pending).toEqual([expect.objectContaining({ failed: true })]);
  });
});

describe('run identity across readers', () => {
  it('the old reader’s resume finds the run a waiting POST owns: it lets go, the run is read once', async () => {
    const t = await setup();
    t.fake.probe = live('r1');
    const { stream } = await startRun(t, 'one');
    stream.push(turnStart('bot_a', 'user', { seq: 0 }), text('First', { seq: 1 }), turnEnd('bot_a', 'm2', { seq: 2 }));
    await t.time.advance(100);
    // r1's tail is lost with the transport; r1 finishes server-side.
    stream.fail();
    await t.time.advance(0);

    // The member's next send claims r2 (announced while the POST is out): its 200 waits behind the old reader.
    const post = deferred<BotsPost>();
    t.fake.posts.push(post.promise);
    const sending = t.engine.send({ text: 'two', images: [], mentions: [] });
    await t.time.advance(0);
    t.rt.emit({ type: 'chat:run', sessionId: SID, runId: 'r2', status: 'running' });
    const second = new FakeStream([
      turnStart('bot_b', 'user', { seq: 0 }),
      text('Second', { seq: 1 }),
      turnEnd('bot_b', 'm4', { seq: 2 }),
      FINISH,
    ]).end();
    post.resolve({ kind: 'stream', events: second.events });
    await sending;

    // The old reader's resume probe now finds r2 in the slot.
    t.fake.probe = live('r2');
    t.fake.attaches.push(new FakeStream([turnStart('bot_b', 'user', { seq: 0, replayed: true }), FINISH]).end());
    t.fake.server.messages.push(
      userRow(1, 'one'),
      message(2, { content: 'First' }),
      userRow(3, 'two'),
      message(4, { bot_id: 'bot_b', content: 'Second' }),
    );
    await t.time.advance(5_000);

    expect(t.fake.calls.attach).toEqual([]);
    expect(runStarts(t.effects, `${SID}:r2`)).toHaveLength(1);
    expect(t.effects.filter((e) => e.type === 'segment-start' && e.botId === 'bot_b')).toEqual([
      { type: 'segment-start', botId: 'bot_b', replayed: false },
    ]);
    expect(t.snap().run).toBeNull();
    expect(t.snap().pending).toEqual([]);
  });

  it('a POST that learns its run only after the old reader switched onto it never reads it again', async () => {
    const t = await setup();
    t.fake.probe = live('r1');
    const { stream } = await startRun(t, 'one');
    stream.push(turnStart('bot_a', 'user', { seq: 0 }), text('First', { seq: 1 }));
    await t.time.advance(100);
    // The member sends; no push reaches this device (nothing latched).
    const post = deferred<BotsPost>();
    t.fake.posts.push(post.promise);
    const sending = t.engine.send({ text: 'two', images: [], mentions: [] });
    await t.time.advance(0);
    // r1's transport drops; the resume finds r2 and reads it from its start.
    t.fake.probe = live('r2');
    const replay = new FakeStream([turnStart('bot_b', 'user', { seq: 0, replayed: true })]);
    t.fake.attaches.push(replay);
    stream.fail();
    await t.time.advance(1_000);
    expect(t.fake.calls.attach).toEqual([-1]);

    // The POST answers 200 with no run id; its probe names r2 — already being read here.
    const second = new FakeStream([turnStart('bot_b', 'user', { seq: 0 }), text('Second', { seq: 1 })]);
    post.resolve({ kind: 'stream', events: second.events });
    await sending;
    await t.time.advance(100);
    replay.push(text('Second', { seq: 1 }), turnEnd('bot_b', 'm4', { seq: 2 }), FINISH).end();
    await t.time.advance(1_000);

    expect(second.opened).toBe(false);
    expect(runStarts(t.effects, `${SID}:r2`)).toHaveLength(1);
  });

  it('a POST whose run was already read to its end here is not read again', async () => {
    const t = await setup();
    t.fake.probe = live('r1');
    const { stream } = await startRun(t, 'one');
    stream.push(turnStart('bot_a', 'user', { seq: 0 }));
    await t.time.advance(100);
    const post = deferred<BotsPost>();
    t.fake.posts.push(post.promise);
    const sending = t.engine.send({ text: 'two', images: [], mentions: [] });
    await t.time.advance(0);
    t.fake.probe = live('r2');
    const replay = new FakeStream([turnStart('bot_b', 'user', { seq: 0, replayed: true })]);
    t.fake.attaches.push(replay);
    stream.fail();
    await t.time.advance(1_000);
    // r2 is announced only now (latched by the POST still out), and read to its end by the old reader.
    t.rt.emit({ type: 'chat:run', sessionId: SID, runId: 'r2', status: 'running' });
    replay.push(turnEnd('bot_b', 'm4', { seq: 1 }), FINISH).end();
    await t.time.advance(1_000);
    expect(runStarts(t.effects, `${SID}:r2`)).toHaveLength(1);

    const second = new FakeStream([turnStart('bot_b', 'user', { seq: 0 }), turnEnd('bot_b', 'm4', { seq: 1 }), FINISH]);
    post.resolve({ kind: 'stream', events: second.events });
    await sending;
    await t.time.advance(1_000);
    expect(second.opened).toBe(false);
    expect(runStarts(t.effects, `${SID}:r2`)).toHaveLength(1);
  });
});

describe('resuming a long run', () => {
  it('drops spread over a long run never use up the resumes: a source that delivered anything starts the count again', async () => {
    const t = await setup();
    t.fake.probe = live('r1');
    const { stream } = await startRun(t);
    stream.push(turnStart('bot_a', 'user', { seq: 0 }));
    await t.time.advance(100);
    const drops = MAX_RESUMES + 2;
    for (let i = 1; i <= drops; i += 1) t.fake.attaches.push(new FakeStream([text(`${i} `, { seq: i })]).fail());
    t.fake.attaches.push(new FakeStream());
    stream.fail();
    await t.time.advance(30_000);
    expect(t.fake.calls.attach).toHaveLength(drops + 1);
    expect(t.snap().run?.segments[0].text).toBe('1 2 3 4 5 6 7 ');
    expect(t.store.getState().running[SID]).toBe('r1');
    expect(t.snap().runActive).toBe(true);
  });

  it('back from the background again and again: the forced re-attaches are no failures', async () => {
    const t = await setup();
    t.fake.probe = live('r1');
    const { stream } = await startRun(t);
    stream.push(turnStart('bot_a', 'user', { seq: 0 }));
    await t.time.advance(0);
    const returns = 2 * (MAX_RESUMES + 1);
    for (let i = 0; i < returns; i += 1) {
      t.fake.attaches.push(new FakeStream());
      t.engine.setForeground(false);
      await t.time.advance(STALE_MS + 1);
      t.engine.setForeground(true);
      await t.time.advance(100);
    }
    expect(t.fake.calls.attach).toHaveLength(returns);
    expect(t.snap().run).not.toBeNull();
    expect(t.store.getState().running[SID]).toBe('r1');
  });

  it('5 failed re-attaches in a row and the last look finds the run over: the busy mark goes', async () => {
    const t = await setup();
    t.fake.probe = live('r1');
    const { stream } = await startRun(t);
    stream.push(turnStart('bot_a', 'user', { seq: 0 }), text('partial', { seq: 1 }));
    await t.time.advance(100);
    for (let i = 0; i < MAX_RESUMES; i += 1) {
      t.fake.probes.push(live('r1'));
      t.fake.attaches.push(new FakeStream().fail());
    }
    t.fake.probe = { active: false, run: { run_id: 'r1', status: 'completed', started_at: 0, next_seq: 9 } };
    stream.fail();
    await t.time.advance(20_000);
    expect(t.fake.calls.attach).toEqual([1, 1, 1, 1, 1]);
    expect(t.store.getState().running[SID]).toBeUndefined();
    expect(t.snap().runActive).toBe(false);
  });
});

describe('stale probe answers', () => {
  it('a running push that overtakes an in-flight probe’s stale "idle": the mark stays, the new run is attached', async () => {
    const t = await setup();
    const stale = deferred<ChatRunProbe | null>();
    t.fake.probes.push(stale.promise);
    t.rt.emit({ type: 'resync' });
    await t.time.advance(0);
    // r2 is claimed and announced before that probe's answer arrives.
    t.store.getState().setRunning(SID, 'r2');
    t.rt.emit({ type: 'chat:run', sessionId: SID, runId: 'r2', status: 'running' });
    t.fake.probe = live('r2');
    t.fake.attaches.push(new FakeStream([turnStart('bot_a', 'user', { seq: 0, replayed: true })]));
    stale.resolve({ active: false });
    await t.time.advance(100);
    expect(t.store.getState().running[SID]).toBe('r2');
    expect(t.fake.calls.attach).toEqual([-1]);
    expect(runStarts(t.effects, `${SID}:r2`)).toHaveLength(1);
    expect(t.snap().runActive).toBe(true);
  });

  it('the opening probe’s stale "idle" never clears a run announced after it was asked', async () => {
    const stale = deferred<ChatRunProbe | null>();
    const t = await setup({ prepare: (fake) => fake.probes.push(stale.promise) });
    t.store.getState().setRunning(SID, 'r2');
    t.fake.probe = live('r2');
    t.fake.attaches.push(new FakeStream([turnStart('bot_a', 'user', { seq: 0, replayed: true })]));
    stale.resolve({ active: false });
    await t.time.advance(100);
    expect(t.store.getState().running[SID]).toBe('r2');
    expect(t.fake.calls.attach).toEqual([-1]);
  });

  it('a polling probe’s stale "idle" never clears a newer mark either', async () => {
    const t = await setup({ status: 'backoff' });
    const stale = deferred<ChatRunProbe | null>();
    t.fake.probes.push(stale.promise);
    await t.time.advance(POLL_GRACE_MS);
    t.store.getState().setRunning(SID, 'r2');
    t.fake.probe = live('r2');
    t.fake.attaches.push(new FakeStream([turnStart('bot_a', 'user', { seq: 0, replayed: true })]));
    stale.resolve({ active: false });
    await t.time.advance(100);
    expect(t.store.getState().running[SID]).toBe('r2');
    expect(t.fake.calls.attach).toEqual([-1]);
  });
});
