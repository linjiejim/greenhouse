/**
 * The Bots sync (./sync.ts): the push → store routing table and the list
 * polling fallback — over the real store logic (./store-core.ts) with a fake
 * API, a fake socket and a virtual clock.
 */

import { describe, expect, it } from 'vitest';
import type { BotConversationSummary } from '../shared/bots';
import type { RealtimeStatus } from './contract';
import { LIST_POLL_MS, LIST_RELOAD_MS, startBotsSync } from './sync';
import { POLL_GRACE_MS } from './thread/polling';
import { conversation, FakeClock, FakeRealtime, makeStore } from './thread/test-fakes';

const row = (sessionId: string, partial: Partial<BotConversationSummary> = {}): BotConversationSummary =>
  conversation(sessionId, partial);

function setup(o: { status?: RealtimeStatus } = {}) {
  const time = new FakeClock();
  const rt = new FakeRealtime(time.clock.now, o.status ?? 'connecting');
  let rows: BotConversationSummary[] = [];
  const { store, calls } = makeStore(
    {
      listConversations: async () => {
        calls.listConversations += 1;
        return { ok: true as const, value: rows };
      },
    },
    time.clock,
  );
  const sync = startBotsSync({ realtime: rt, store, clock: time.clock });
  sync.setForeground(true);
  const setRows = async (next: BotConversationSummary[]) => {
    rows = next;
    await store.getState().loadConversations();
    await time.advance(0);
  };
  return { time, rt, store, calls, sync, setRows };
}

describe('routing', () => {
  it('resync (connected) re-reads Bots, conversations, pending cards and the busy seed', async () => {
    const t = setup();
    const before = { ...t.calls };
    t.rt.emit({ type: 'resync' });
    await t.time.advance(0);
    expect(t.calls.listBots).toBe(before.listBots + 1);
    expect(t.calls.listConversations).toBe(before.listConversations + 1);
    expect(t.calls.listRequests).toBe(before.listRequests + 1);
    expect(t.calls.listChatRuns).toBe(before.listChatRuns + 1);
  });

  it('already connected when started (Bots turned on mid-session): reads at once', async () => {
    const time = new FakeClock();
    const rt = new FakeRealtime(time.clock.now, 'open');
    const { store, calls } = makeStore({}, time.clock);
    startBotsSync({ realtime: rt, store, clock: time.clock });
    await time.advance(0);
    expect(calls.listConversations).toBe(1);
    expect(calls.listChatRuns).toBe(1);
  });

  it('chat:run marks the session busy and clears only its own run; a known Bots conversation reloads the list', async () => {
    const t = setup();
    await t.setRows([row('s1')]);
    const lists = t.calls.listConversations;

    t.rt.emit({ type: 'chat:run', sessionId: 's1', runId: 'r1', status: 'running' });
    t.rt.emit({ type: 'chat:run', sessionId: 'plain', runId: 'p1', status: 'running' });
    expect(t.store.getState().running).toEqual({ s1: 'r1', plain: 'p1' });
    await t.time.advance(LIST_RELOAD_MS);
    expect(t.calls.listConversations).toBe(lists + 1);

    // A late "completed" of an older run does not clear the newer one.
    t.rt.emit({ type: 'chat:run', sessionId: 's1', runId: 'r1', status: 'running' });
    t.store.getState().setRunning('s1', 'r2');
    t.rt.emit({ type: 'chat:run', sessionId: 's1', runId: 'r1', status: 'completed' });
    expect(t.store.getState().running.s1).toBe('r2');
    t.rt.emit({ type: 'chat:run', sessionId: 's1', runId: 'r2', status: 'error' });
    expect(t.store.getState().running.s1).toBeUndefined();

    // A plain conversation's run never reloads the Bots list.
    const now = t.calls.listConversations;
    await t.time.advance(LIST_RELOAD_MS);
    t.rt.emit({ type: 'chat:run', sessionId: 'plain', runId: 'p1', status: 'completed' });
    await t.time.advance(LIST_RELOAD_MS);
    expect(t.calls.listConversations).toBe(now + 1); // the s1 burst above, not the plain one
  });

  it('a burst of bots:conversation is one list read (400 ms)', async () => {
    const t = setup();
    const lists = t.calls.listConversations;
    for (let i = 0; i < 5; i += 1) {
      t.rt.emit({ type: 'bots:conversation', sessionId: `s${i}` });
      await t.time.advance(100);
    }
    expect(t.calls.listConversations).toBe(lists);
    await t.time.advance(LIST_RELOAD_MS);
    expect(t.calls.listConversations).toBe(lists + 1);
  });

  it('bots:attention sets the count at once and re-reads the pending list (debounced)', async () => {
    const t = setup();
    const pending = t.calls.listRequests;
    t.rt.emit({ type: 'bots:attention', pending: 3 });
    t.rt.emit({ type: 'bots:attention', pending: 4 });
    expect(t.store.getState().pendingTotal).toBe(4);
    await t.time.advance(LIST_RELOAD_MS);
    expect(t.calls.listRequests).toBe(pending + 1);
  });

  it('after dispose nothing is routed', async () => {
    const t = setup();
    t.sync.dispose();
    const lists = t.calls.listConversations;
    t.rt.emit({ type: 'bots:conversation', sessionId: 's1' });
    t.rt.emit({ type: 'chat:run', sessionId: 's1', runId: 'r1', status: 'running' });
    await t.time.advance(LIST_RELOAD_MS);
    expect(t.calls.listConversations).toBe(lists);
    expect(t.store.getState().running).toEqual({});
  });
});

describe('polling fallback', () => {
  it('lists every 30 s once the socket has been down 10 s (foreground only); none while open', async () => {
    const t = setup({ status: 'open' });
    await t.time.advance(0);
    const lists = t.calls.listConversations;
    const pending = t.calls.listRequests;
    await t.time.advance(5 * 60_000);
    expect(t.calls.listConversations).toBe(lists);

    t.rt.setStatus('backoff');
    await t.time.advance(POLL_GRACE_MS);
    expect(t.calls.listConversations).toBe(lists + 1);
    expect(t.calls.listRequests).toBe(pending + 1);
    await t.time.advance(LIST_POLL_MS);
    expect(t.calls.listConversations).toBe(lists + 2);

    t.sync.setForeground(false);
    await t.time.advance(5 * LIST_POLL_MS);
    expect(t.calls.listConversations).toBe(lists + 2);
  });

  it('each poll re-reads the busy seed too: a mark whose end was missed is cleared, a run started elsewhere shows', async () => {
    const t = setup({ status: 'open' });
    await t.time.advance(0);
    // The socket goes down: this run's completed push never arrives.
    t.store.getState().setRunning('s1', 'r1');
    t.rt.setStatus('backoff');
    const runs = t.calls.listChatRuns;
    await t.time.advance(POLL_GRACE_MS);
    expect(t.calls.listChatRuns).toBe(runs + 1);
    expect(t.store.getState().running).toEqual({});
    await t.time.advance(LIST_POLL_MS);
    expect(t.calls.listChatRuns).toBe(runs + 2);
  });
});
