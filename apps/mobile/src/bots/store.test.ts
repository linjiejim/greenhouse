/**
 * The Bots store's logic and selectors (./store-core.ts — ./store.ts only binds them to zustand
 * and the real API). Runs in the ROOT vitest unit project: a hand-rolled set/get stands in for
 * zustand, the API and the clock are fakes, so no React Native module loads.
 */

import { describe, expect, it, vi } from 'vitest';
import type { BotConversationSummary, BotRequestView, BotView } from '../shared/bots';
import type { BotsOverview } from '../shared/bots-wire';
import {
  attentionCount,
  createBotsSlice,
  drawerRows,
  initialBotsData,
  PENDING_RELOAD_MS,
  rowSignal,
  sproutyBot,
  sproutyDm,
  type BotsData,
  type BotsState,
  type BotsStoreDeps,
  type SetBots,
} from './store-core';

// ─── Fixtures ────────────────────────────────────────────

function bot(id: string, partial: Partial<BotView> = {}): BotView {
  return {
    id,
    name: id,
    role: '',
    description: '',
    instructions: '',
    avatar: {},
    model_id: null,
    tools: null,
    max_steps: null,
    template_key: null,
    status: 'active',
    dm_session_id: null,
    current_version: 1,
    user_id: 'u1',
    last_active_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...partial,
  };
}

const SPROUTY = bot('bot_sprouty', { name: 'Sprouty', template_key: 'sprouty', dm_session_id: 's_sprouty' });

function dm(sessionId: string, botId: string, partial: Partial<BotConversationSummary> = {}): BotConversationSummary {
  return {
    session_id: sessionId,
    kind: 'direct',
    title: null,
    owner_bot_id: botId,
    lead_bot_id: botId,
    members: [{ bot_id: botId, role: 'owner', position: 0 }],
    last_message: null,
    attention: 'idle',
    pending_requests: 0,
    last_activity_at: '2026-10-08T00:00:00.000Z',
    ...partial,
  };
}

function group(
  sessionId: string,
  botIds: string[],
  partial: Partial<BotConversationSummary> = {},
): BotConversationSummary {
  return {
    ...dm(sessionId, botIds[0]),
    kind: 'group',
    owner_bot_id: null,
    members: botIds.map((botId, position) => ({ bot_id: botId, role: position === 0 ? 'lead' : 'member', position })),
    ...partial,
  };
}

function request(id: string, sessionId: string, partial: Partial<BotRequestView> = {}): BotRequestView {
  return {
    id,
    session_id: sessionId,
    bot_id: 'bot_a',
    kind: 'approval',
    status: 'pending',
    payload: { action: 'tool_call', title: 'Write a doc', details: [], allow_always: false },
    result: null,
    expires_at: null,
    created_at: '2026-10-08T00:00:00.000Z',
    ...partial,
  };
}

function data(partial: Partial<BotsData> = {}): BotsData {
  const bots = partial.bots ?? [];
  const archived = partial.archived ?? [];
  return {
    ...initialBotsData(),
    botsLoaded: true,
    byId: Object.fromEntries([...archived, ...bots].map((b) => [b.id, b])),
    ...partial,
  };
}

// ─── A store with fakes ──────────────────────────────────

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const overview = (bots: BotView[], extra: Partial<BotsOverview> = {}): BotsOverview => ({
  bots: bots.filter((b) => b.status === 'active'),
  archived_bots: bots.filter((b) => b.status !== 'active'),
  computer: { state: 'disabled', reason: null, hardened: false },
  vault_available: false,
  pending_requests: 0,
  ...extra,
});

function makeStore(api: Partial<BotsStoreDeps['api']> = {}) {
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const deps: BotsStoreDeps = {
    api: {
      listBots: vi.fn(async () => ({ ok: true as const, value: overview([SPROUTY]) })),
      bootstrapBots: vi.fn(async () => ({
        ok: true as const,
        value: { bot: SPROUTY, dm_session_id: 's_sprouty', created: false },
      })),
      listConversations: vi.fn(async () => ({ ok: true as const, value: [] })),
      listRequests: vi.fn(async () => ({ ok: true as const, value: [] })),
      decideRequest: vi.fn(),
      listChatRuns: vi.fn(async () => []),
      ...api,
    } as BotsStoreDeps['api'],
    clock: {
      setTimeout: (fn, ms) => {
        const timer = { fn, ms, live: true };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (handle) => {
        (handle as { live: boolean }).live = false;
      },
    },
  };
  let state: BotsState;
  const set: SetBots = (partial) => {
    state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) };
  };
  const get = () => state;
  state = createBotsSlice(set, get, deps);
  const flushTimers = () => {
    for (const timer of timers.splice(0)) if (timer.live) timer.fn();
  };
  return { get, set, api: deps.api, timers, flushTimers };
}

// ─── Selectors ───────────────────────────────────────────

describe('drawerRows', () => {
  const bots = [
    SPROUTY,
    ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => bot(`bot_${n}`, { name: `Bot ${n.toUpperCase()}` })),
  ];
  const archivedBot = bot('bot_old', { name: 'Old Fern', status: 'archived' });
  const rows = [
    dm('s_g', 'bot_g'),
    dm('s_old', 'bot_old'),
    dm('s_sprouty', 'bot_sprouty'),
    dm('s_a', 'bot_a', {
      last_message: { preview: 'quarterly numbers', bot_id: 'bot_a', role: 'assistant', created_at: '' },
    }),
    group('s_grp', ['bot_b', 'bot_c'], { title: 'Writing club' }),
    dm('s_d', 'bot_d'),
    dm('s_e', 'bot_e'),
    dm('s_f', 'bot_f'),
  ];
  const s = data({ bots, archived: [archivedBot], conversations: rows });

  it('pins Sprouty, keeps the server order, collapses after 5 and files read-only rows under Archived', () => {
    const out = drawerRows(s, { query: '', expanded: false });
    expect(out.pinned?.session_id).toBe('s_sprouty');
    expect(out.recent.map((r) => r.session_id)).toEqual(['s_g', 's_a', 's_grp', 's_d', 's_e']);
    expect(out.moreCount).toBe(1);
    expect(out.archived.map((r) => r.session_id)).toEqual(['s_old']);
    const expanded = drawerRows(s, { query: '', expanded: true });
    expect(expanded.recent.map((r) => r.session_id)).toEqual(['s_g', 's_a', 's_grp', 's_d', 's_e', 's_f']);
    expect(expanded.moreCount).toBe(0);
    expect(drawerRows(s, { query: '', expanded: false, recent: 2 }).moreCount).toBe(4);
  });

  it('searches titles, member names and previews — every part, never collapsed', () => {
    expect(drawerRows(s, { query: ' writing ', expanded: false }).recent.map((r) => r.session_id)).toEqual(['s_grp']);
    expect(drawerRows(s, { query: 'bot c', expanded: false }).recent.map((r) => r.session_id)).toEqual(['s_grp']);
    expect(drawerRows(s, { query: 'QUARTERLY', expanded: false }).recent.map((r) => r.session_id)).toEqual(['s_a']);
    const sprouty = drawerRows(s, { query: 'sprouty', expanded: false });
    expect([sprouty.pinned?.session_id, sprouty.recent.length]).toEqual(['s_sprouty', 0]);
    const fern = drawerRows(s, { query: 'fern', expanded: false });
    expect([fern.pinned, fern.recent.length, fern.archived.map((r) => r.session_id)]).toEqual([null, 0, ['s_old']]);
    const bot = drawerRows(s, { query: 'bot', expanded: false });
    expect([bot.recent.length, bot.moreCount]).toEqual([6, 0]);
  });

  it('counts every row as replyable until the Bot list arrives; no pin without Sprouty', () => {
    const early = drawerRows({ ...s, bots: [], byId: {}, botsLoaded: false }, { query: '', expanded: true });
    expect(early.pinned).toBeNull();
    expect(early.archived).toEqual([]);
    expect(early.recent).toHaveLength(rows.length);
  });
});

describe('rowSignal / attentionCount', () => {
  it('needs you beats unread; unread is hidden on the open thread; busy comes from `running` only', () => {
    const s = data({ running: { s_busy: 'run_1' } });
    expect(rowSignal(s, dm('s1', 'b', { pending_requests: 2, attention: 'needs_you' }), null)).toEqual({
      badge: 'needs_you',
      needsYouCount: 2,
      working: false,
    });
    expect(rowSignal(s, dm('s1', 'b', { attention: 'unread' }), null).badge).toBe('unread');
    expect(rowSignal(s, dm('s1', 'b', { attention: 'unread' }), 's1').badge).toBeNull();
    expect(rowSignal(s, dm('s1', 'b', { attention: 'working' }), null)).toEqual({
      badge: null,
      needsYouCount: 0,
      working: false,
    });
    expect(rowSignal(s, dm('s_busy', 'b'), null).working).toBe(true);
  });

  it('counts the other conversations that need the member or have something unread', () => {
    const s = data({
      conversations: [
        dm('s1', 'a', { pending_requests: 1 }),
        dm('s2', 'b', { attention: 'unread' }),
        dm('s3', 'c', { attention: 'working' }),
        dm('s4', 'd', { attention: 'unread', pending_requests: 3 }),
      ],
    });
    expect(attentionCount(s, null)).toBe(3);
    expect(attentionCount(s, 's4')).toBe(2);
  });
});

describe('sproutyBot / sproutyDm', () => {
  it('finds Sprouty and its DM — from the Bot, else from its row', () => {
    expect(sproutyBot(data({ bots: [bot('x'), SPROUTY] }))?.id).toBe('bot_sprouty');
    expect(sproutyDm(data({ bots: [SPROUTY] }))).toBe('s_sprouty');
    const noPointer = { ...SPROUTY, dm_session_id: null };
    expect(sproutyDm(data({ bots: [noPointer], conversations: [dm('s_row', 'bot_sprouty')] }))).toBe('s_row');
    expect(sproutyDm(data({ bots: [noPointer] }))).toBeNull();
    expect(sproutyDm(data())).toBeNull();
  });
});

// ─── Actions ─────────────────────────────────────────────

describe('loads', () => {
  it('drop an answer that arrives after reset() (generation)', async () => {
    const answer = deferred<Awaited<ReturnType<BotsStoreDeps['api']['listBots']>>>();
    const store = makeStore({ listBots: vi.fn(() => answer.promise) });
    const load = store.get().loadBots();
    store.get().reset();
    answer.resolve({ ok: true, value: overview([SPROUTY, bot('bot_a')]) });
    await load;
    expect(store.get().bots).toEqual([]);
    expect(store.get().botsLoaded).toBe(false);
    expect(store.get().generation).toBe(1);
  });

  it('publish the directory: active and archived split by each Bot’s own status, all in byId', async () => {
    const old = bot('bot_old', { status: 'archived' });
    const store = makeStore({
      listBots: vi.fn(async () => ({ ok: true as const, value: overview([SPROUTY, old], { pending_requests: 2 }) })),
    });
    await store.get().loadBots();
    const s = store.get();
    expect([s.bots.map((b) => b.id), s.archived.map((b) => b.id), Object.keys(s.byId).sort()]).toEqual([
      ['bot_sprouty'],
      ['bot_old'],
      ['bot_old', 'bot_sprouty'],
    ]);
    expect([s.botsLoaded, s.pendingTotal]).toEqual([true, 2]);
  });

  it('share one in-flight request, and one follow-up for calls made meanwhile', async () => {
    const answers = [
      deferred<{ ok: true; value: BotConversationSummary[] }>(),
      deferred<{ ok: true; value: BotConversationSummary[] }>(),
    ];
    let call = 0;
    const listConversations = vi.fn(() => answers[call++].promise);
    const store = makeStore({ listConversations });
    await store.get().loadBots();
    const first = store.get().loadConversations();
    const second = store.get().loadConversations();
    const third = store.get().loadConversations();
    expect(second).toBe(third);
    answers[0].resolve({ ok: true, value: [dm('s1', 'bot_sprouty')] });
    await first;
    answers[1].resolve({ ok: true, value: [dm('s2', 'bot_sprouty', { pending_requests: 2 })] });
    await second;
    expect(listConversations).toHaveBeenCalledTimes(2);
    expect(store.get().conversations.map((r) => r.session_id)).toEqual(['s2']);
    expect(store.get().pendingTotal).toBe(2);
  });

  it('drop a follow-up queued before reset()', async () => {
    const answer = deferred<{ ok: true; value: BotConversationSummary[] }>();
    const listConversations = vi.fn(() => answer.promise);
    const store = makeStore({ listConversations });
    const first = store.get().loadConversations();
    const followUp = store.get().loadConversations();
    store.get().reset();
    answer.resolve({ ok: true, value: [dm('s1', 'bot_a')] });
    await Promise.all([first, followUp]);
    expect(listConversations).toHaveBeenCalledTimes(1);
    expect(store.get().conversations).toEqual([]);
  });

  it('close for 403 / an older server; a blip is `failed` and the next good answer clears it', async () => {
    const forbidden = makeStore({
      listConversations: vi.fn(async () => ({ ok: false as const, status: 403, code: null })),
    });
    await forbidden.get().loadConversations();
    expect(forbidden.get().error).toBe('forbidden');
    await forbidden.get().loadConversations();
    await forbidden.get().loadPending();
    expect(forbidden.api.listConversations).toHaveBeenCalledTimes(1);
    expect(forbidden.api.listRequests).not.toHaveBeenCalled();
    // Identity management still loads the Bot list while the threads are closed.
    await forbidden.get().loadBots();
    expect(forbidden.get().botsLoaded).toBe(true);

    const missing = makeStore({ listBots: vi.fn(async () => ({ ok: false as const, status: 404, code: null })) });
    await missing.get().loadBots();
    expect(missing.get().error).toBe('missing');
    await missing.get().loadBots();
    expect(missing.api.listBots).toHaveBeenCalledTimes(1);

    let online = false;
    const flaky = makeStore({
      listBots: vi.fn(async () =>
        online ? { ok: true as const, value: overview([SPROUTY]) } : { ok: false as const, status: 0, code: null },
      ),
    });
    await flaky.get().loadBots();
    expect(flaky.get().error).toBe('failed');
    online = true;
    await flaky.get().loadBots();
    expect(flaky.get().error).toBeNull();
  });

  it('learn a Bot made elsewhere before publishing the list — one re-read per unknown id', async () => {
    let known = [SPROUTY];
    const store = makeStore({
      listBots: vi.fn(async () => ({ ok: true as const, value: overview(known) })),
      listConversations: vi.fn(async () => ({ ok: true as const, value: [dm('s_new', 'bot_new')] })),
    });
    await store.get().loadBots();
    known = [SPROUTY, bot('bot_new', { name: 'New' })];
    await store.get().loadConversations();
    expect(store.get().byId.bot_new?.name).toBe('New');
    await store.get().ensureBotsKnown(['bot_new', 'bot_gone']);
    await store.get().ensureBotsKnown(['bot_gone']);
    // initial + the new row's re-read + one for bot_gone
    expect(store.api.listBots).toHaveBeenCalledTimes(3);
  });

  it('seed `running` from the runs list', async () => {
    const store = makeStore({
      listChatRuns: vi.fn(async () => [{ session_id: 's1', run_id: 'r1', started_at: 1, next_seq: 0 }]),
    });
    store.get().setRunning('s_stale', 'r0');
    await store.get().seedRuns();
    expect(store.get().running).toEqual({ s1: 'r1' });
  });

  it('a seed answer never undoes a busy mark that changed while it was out', async () => {
    type Runs = Array<{ session_id: string; run_id: string; started_at: number; next_seq: number }>;
    const answer = deferred<Runs | null>();
    const store = makeStore({ listChatRuns: vi.fn(() => answer.promise) });
    store.get().setRunning('s1', 'r1');
    store.get().setRunning('s_stale', 'r0');
    const seeding = store.get().seedRuns();
    // Meanwhile: r1's completed push, and a new run announced in s2.
    store.get().setRunning('s1', null);
    store.get().setRunning('s2', 'r2');
    answer.resolve([
      { session_id: 's1', run_id: 'r1', started_at: 1, next_seq: 0 },
      { session_id: 's3', run_id: 'r3', started_at: 1, next_seq: 0 },
    ]);
    await seeding;
    expect(store.get().running).toEqual({ s2: 'r2', s3: 'r3' });

    // The next seed (nothing changed while it was out) is the truth again.
    const next = deferred<Runs | null>();
    store.api.listChatRuns = vi.fn(() => next.promise);
    const again = store.get().seedRuns();
    next.resolve([]);
    await again;
    expect(store.get().running).toEqual({});
  });
});

describe('ensureSprouty', () => {
  it('returns the DM it already knows without bootstrapping', async () => {
    const store = makeStore();
    expect(await store.get().ensureSprouty()).toBe('s_sprouty');
    expect(store.api.bootstrapBots).not.toHaveBeenCalled();
  });

  it('bootstraps once when Sprouty or its DM is missing, and pins it straight away', async () => {
    let bootstrapped = false;
    const store = makeStore({
      listBots: vi.fn(async () => ({ ok: true as const, value: overview(bootstrapped ? [SPROUTY] : []) })),
      bootstrapBots: vi.fn(async () => {
        bootstrapped = true;
        return {
          ok: true as const,
          value: { bot: { ...SPROUTY, dm_session_id: null }, dm_session_id: 's_sprouty', created: true },
        };
      }),
    });
    const pending = Promise.all([store.get().ensureSprouty(), store.get().ensureSprouty()]);
    expect(await pending).toEqual(['s_sprouty', 's_sprouty']);
    expect(store.api.bootstrapBots).toHaveBeenCalledTimes(1);
    expect(sproutyDm(store.get())).toBe('s_sprouty');
    expect(store.api.listConversations).toHaveBeenCalled();
  });

  it('may retry after a failure; a 403 closes the surfaces', async () => {
    const bootstrapBots = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 0, code: null, message: '' })
      .mockResolvedValueOnce({ ok: true, value: { bot: SPROUTY, dm_session_id: 's_sprouty', created: true } });
    const store = makeStore({
      listBots: vi.fn(async () => ({ ok: true as const, value: overview([]) })),
      bootstrapBots,
    });
    expect(await store.get().ensureSprouty()).toBeNull();
    await Promise.resolve();
    expect(await store.get().ensureSprouty()).toBe('s_sprouty');

    const refused = makeStore({
      listBots: vi.fn(async () => ({ ok: true as const, value: overview([]) })),
      bootstrapBots: vi.fn(async () => ({ ok: false as const, status: 403, code: null, message: '' })),
    });
    expect(await refused.get().ensureSprouty()).toBeNull();
    expect(refused.get().error).toBe('forbidden');
    expect(await refused.get().ensureSprouty()).toBeNull();
    expect(refused.api.bootstrapBots).toHaveBeenCalledTimes(1);
  });
});

describe('decide', () => {
  const card = request('r1', 's2', { kind: 'bot_create' });

  it('ok: remembers the result, drops the card from the counts at once, re-reads pending soon', async () => {
    const settled = { ...card, status: 'resolved' as const };
    const store = makeStore({
      decideRequest: vi.fn(async () => ({ ok: true as const, value: settled })),
      // The server's count after the decision (the directory re-read publishes it).
      listBots: vi.fn(async () => ({ ok: true as const, value: overview([SPROUTY], { pending_requests: 1 }) })),
    });
    store.set({
      pendingRequests: [card, request('r2', 's3')],
      pendingTotal: 2,
      conversations: [
        dm('s2', 'bot_a', { pending_requests: 1, attention: 'needs_you' }),
        dm('s3', 'bot_b', { pending_requests: 1 }),
      ],
    });
    expect(await store.get().decide(card, { decision: 'approve' })).toEqual({ kind: 'ok', request: settled });
    const s = store.get();
    expect(s.requestOverrides.r1).toEqual(settled);
    expect(s.pendingRequests.map((r) => r.id)).toEqual(['r2']);
    expect(s.pendingTotal).toBe(1);
    expect(s.conversations[0]).toMatchObject({ pending_requests: 0, attention: 'idle' });
    expect(s.conversations[1].pending_requests).toBe(1);
    // bot_create changed the directory.
    expect(store.api.listBots).toHaveBeenCalledTimes(1);
    expect(store.timers.map((t) => t.ms)).toEqual([PENDING_RELOAD_MS]);
    store.flushTimers();
    expect(store.api.listRequests).toHaveBeenCalledWith('pending');
  });

  it('409 already settled elsewhere → stale; any other refusal keeps the card pending', async () => {
    const decideRequest = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, code: 'already_decided', message: 'Already decided' })
      .mockResolvedValueOnce({ ok: false, status: 409, code: null, message: '' })
      .mockResolvedValueOnce({ ok: false, status: 409, code: 'page_gone', message: 'The page is gone' })
      .mockResolvedValueOnce({ ok: false, status: 0, code: null, message: '' });
    const store = makeStore({ decideRequest });
    expect(await store.get().decide(card, { decision: 'approve' })).toEqual({ kind: 'stale' });
    expect(await store.get().decide(card, { decision: 'approve' })).toEqual({ kind: 'stale' });
    expect(await store.get().decide(card, { decision: 'approve' })).toEqual({
      kind: 'refused',
      status: 409,
      code: 'page_gone',
      message: 'The page is gone',
    });
    expect(await store.get().decide(card, { decision: 'deny' })).toMatchObject({ kind: 'refused', status: 0 });
    expect(store.get().requestOverrides).toEqual({});
  });
});

describe('small writes', () => {
  it('noteRead, running, visible thread, pending total, a 403 seen elsewhere', () => {
    const store = makeStore();
    store.set({ conversations: [dm('s1', 'a', { attention: 'unread' }), dm('s2', 'b', { attention: 'unread' })] });
    store.get().noteRead('s1');
    expect(store.get().conversations.map((r) => r.attention)).toEqual(['idle', 'unread']);
    store.get().setRunning('s1', 'r1');
    store.get().setRunning('s2', 'r2');
    store.get().setRunning('s1', null);
    expect(store.get().running).toEqual({ s2: 'r2' });
    store.get().setVisibleThread('s2');
    expect(store.get().visibleThread).toBe('s2');
    store.get().setPendingTotal(-3);
    expect(store.get().pendingTotal).toBe(0);
    store.get().noteForbidden();
    expect(store.get().error).toBe('forbidden');
  });
});
