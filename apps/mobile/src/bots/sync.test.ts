/**
 * The Bots sync (./sync.ts): the push → store routing table, report-arrival
 * detection (five conditions, dedupe, one request at a time, the optional S2
 * field) and the list polling fallback — over the real store logic
 * (./store-core.ts) with a fake API, a fake socket and a virtual clock.
 */

import { describe, expect, it } from 'vitest';
import type { BotConversationSummary, BotMessage } from '../shared/bots';
import type { ConversationPage } from '../shared/bots-wire';
import type { RealtimeStatus } from './contract';
import { LIST_POLL_MS, LIST_RELOAD_MS, startBotsSync } from './sync';
import { POLL_GRACE_MS } from './thread/polling';
import { conversation, deferred, FakeClock, FakeRealtime, makeStore, message } from './thread/test-fakes';

type Read = { ok: true; value: ConversationPage } | { ok: false; status: number; code: string | null };

const row = (sessionId: string, partial: Partial<BotConversationSummary> = {}): BotConversationSummary =>
  conversation(sessionId, partial);
const last = (createdAt: string, partial: Partial<NonNullable<BotConversationSummary['last_message']>> = {}) => ({
  preview: '…',
  bot_id: 'bot_a',
  role: 'assistant',
  created_at: createdAt,
  ...partial,
});
const report = (sessionId: string, title = 'Meeting notes'): BotMessage =>
  message(9, {
    role: 'system',
    bot_event: { kind: 'task_report', run_id: 'run_1', bot_id: 'bot_a', title, status: 'succeeded' },
  });

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
  const lookups: string[] = [];
  const answers = new Map<string, Read | Promise<Read>>();
  const api = {
    getConversation: async (sessionId: string, opts?: { beforeSeq?: number; limit?: number }): Promise<Read> => {
      lookups.push(`${sessionId}:${opts?.limit}`);
      return (
        answers.get(sessionId) ?? { ok: true, value: { conversation: conversation(sessionId), messages: [message(1)], has_more: false } }
      );
    },
  };
  const sync = startBotsSync({ realtime: rt, store, api, clock: time.clock });
  sync.setForeground(true);
  const setRows = async (next: BotConversationSummary[]) => {
    rows = next;
    await store.getState().loadConversations();
    await time.advance(0);
  };
  return { time, rt, store, calls, sync, lookups, answers, setRows };
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
    startBotsSync({ realtime: rt, store, api: { getConversation: async () => ({ ok: false, status: 0, code: null }) }, clock: time.clock });
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

describe('report arrivals', () => {
  it('the first list is the baseline; a changed, idle, not-visible, Bot-written row is looked at once', async () => {
    const t = setup();
    t.answers.set('s1', { ok: true, value: { conversation: conversation('s1'), messages: [report('s1')], has_more: false } });
    await t.setRows([row('s1', { last_message: last('2026-10-08T00:00:00.000Z') })]);
    expect(t.lookups).toEqual([]);

    await t.setRows([row('s1', { attention: 'unread', last_message: last('2026-10-08T00:05:00.000Z') })]);
    expect(t.lookups).toEqual(['s1:1']);
    expect(t.store.getState().arrivals.s1).toEqual({
      botId: 'bot_a',
      title: 'Meeting notes',
      status: 'succeeded',
      at: t.time.clock.now(),
    });

    // The same last message again (another reload, attention unchanged): not looked at twice.
    await t.setRows([row('s1', { attention: 'unread', last_message: last('2026-10-08T00:05:00.000Z') })]);
    expect(t.lookups).toEqual(['s1:1']);
  });

  it('skips the thread on screen, a busy one, the member’s own message, an unchanged row and non-reports', async () => {
    const t = setup();
    const at = (m: number) => `2026-10-08T00:0${m}:00.000Z`;
    await t.setRows([
      row('visible', { last_message: last(at(0)) }),
      row('busy', { last_message: last(at(0)) }),
      row('mine', { last_message: last(at(0)) }),
      row('same', { last_message: last(at(0)) }),
      row('plain', { last_message: last(at(0)) }),
    ]);
    t.store.getState().setVisibleThread('visible');
    t.store.getState().setRunning('busy', 'r1');
    await t.setRows([
      row('visible', { attention: 'unread', last_message: last(at(1)) }),
      row('busy', { attention: 'unread', last_message: last(at(1)) }),
      row('mine', { last_message: last(at(1), { role: 'user', bot_id: null }) }),
      row('same', { last_message: last(at(0)) }),
      row('plain', { attention: 'unread', last_message: last(at(1)) }),
    ]);
    await t.time.advance(0);
    expect(t.lookups).toEqual(['plain:1']);
    // `plain`'s last row is an ordinary reply: no arrival.
    expect(t.store.getState().arrivals).toEqual({});
  });

  it('one lookup in flight at a time; the next starts when it answers', async () => {
    const t = setup();
    await t.setRows([row('a'), row('b')]);
    const first = deferred<Read>();
    t.answers.set('a', first.promise);
    t.answers.set('b', { ok: true, value: { conversation: conversation('b'), messages: [report('b', 'Second')], has_more: false } });
    await t.setRows([
      row('a', { last_message: last('2026-10-08T01:00:00.000Z') }),
      row('b', { last_message: last('2026-10-08T01:00:00.000Z') }),
    ]);
    expect(t.lookups).toEqual(['a:1']);
    first.resolve({ ok: true, value: { conversation: conversation('a'), messages: [report('a', 'First')], has_more: false } });
    await t.time.advance(0);
    expect(t.lookups).toEqual(['a:1', 'b:1']);
    expect(Object.keys(t.store.getState().arrivals).sort()).toEqual(['a', 'b']);
  });

  it('a thread opened while its lookup was in flight gets no arrival', async () => {
    const t = setup();
    await t.setRows([row('a')]);
    const held = deferred<Read>();
    t.answers.set('a', held.promise);
    await t.setRows([row('a', { last_message: last('2026-10-08T02:00:00.000Z') })]);
    t.store.getState().setVisibleThread('a');
    held.resolve({ ok: true, value: { conversation: conversation('a'), messages: [report('a')], has_more: false } });
    await t.time.advance(0);
    expect(t.store.getState().arrivals).toEqual({});
  });

  it('another account / station (store reset): answers in flight are dropped, queued lookups forgotten', async () => {
    const t = setup();
    await t.setRows([row('a'), row('b')]);
    const held = deferred<Read>();
    t.answers.set('a', held.promise);
    await t.setRows([
      row('a', { last_message: last('2026-10-08T04:00:00.000Z') }),
      row('b', { last_message: last('2026-10-08T04:00:00.000Z') }),
    ]);
    expect(t.lookups).toEqual(['a:1']);
    t.store.getState().reset();
    held.resolve({ ok: true, value: { conversation: conversation('a'), messages: [report('a')], has_more: false } });
    await t.time.advance(0);
    expect(t.lookups).toEqual(['a:1']);
    expect(t.store.getState().arrivals).toEqual({});
  });

  it('with the server’s event_kind (S2): a non-report costs no request', async () => {
    const t = setup();
    await t.setRows([row('a'), row('b')]);
    t.answers.set('b', { ok: true, value: { conversation: conversation('b'), messages: [report('b')], has_more: false } });
    await t.setRows([
      row('a', { last_message: { ...last('2026-10-08T03:00:00.000Z'), event_kind: null } as BotConversationSummary['last_message'] }),
      row('b', {
        last_message: { ...last('2026-10-08T03:00:00.000Z'), event_kind: 'task_report' } as BotConversationSummary['last_message'],
      }),
    ]);
    await t.time.advance(0);
    expect(t.lookups).toEqual(['b:1']);
    expect(Object.keys(t.store.getState().arrivals)).toEqual(['b']);
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
});
