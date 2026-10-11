/**
 * The Bots store's logic and selectors (./store-core.ts — ./store.ts only binds them to zustand
 * and the real API). Runs in the ROOT vitest unit project: a hand-rolled set/get stands in for
 * zustand, the API and the clock are fakes, so no React Native module loads.
 */

import { describe, expect, it, vi } from 'vitest';
import type { BotConversationSummary, BotRequestView, BotView, SharedBotView } from '../shared/bots';
import type { BotsOverview } from '../shared/bots-wire';
import {
  attentionCount,
  createBotsSlice,
  drawerRows,
  initialBotsData,
  PENDING_RELOAD_MS,
  rowReplyable,
  rowSharedAgent,
  rowSignal,
  sproutyBot,
  sproutyDm,
  taskChatRow,
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
  shared_bots: [],
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
      listTaskChats: vi.fn(async () => ({ ok: true as const, value: [] })),
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
    expect(out.recent.map((r) => r.session_id)).toEqual(['s_g', 's_a', 's_d', 's_e', 's_f']);
    expect(out.moreCount).toBe(0);
    // an archived Bot's DM, and an old group chat — group chats were retired, kept as records
    expect(out.archived.map((r) => r.session_id)).toEqual(['s_old', 's_grp']);
    const more = drawerRows({ ...s, conversations: [...rows, dm('s_h', 'bot_c')] }, { query: '', expanded: false });
    expect([more.recent.length, more.moreCount]).toEqual([5, 1]);
    const expanded = drawerRows({ ...s, conversations: [...rows, dm('s_h', 'bot_c')] }, { query: '', expanded: true });
    expect(expanded.recent.map((r) => r.session_id)).toEqual(['s_g', 's_a', 's_d', 's_e', 's_f', 's_h']);
    expect(expanded.moreCount).toBe(0);
    expect(drawerRows(s, { query: '', expanded: false, recent: 2 }).moreCount).toBe(3);
  });

  it('searches titles, member names and previews — every part, never collapsed', () => {
    expect(drawerRows(s, { query: ' writing ', expanded: false }).archived.map((r) => r.session_id)).toEqual(['s_grp']);
    expect(drawerRows(s, { query: 'bot c', expanded: false }).archived.map((r) => r.session_id)).toEqual(['s_grp']);
    expect(drawerRows(s, { query: 'QUARTERLY', expanded: false }).recent.map((r) => r.session_id)).toEqual(['s_a']);
    const sprouty = drawerRows(s, { query: 'sprouty', expanded: false });
    expect([sprouty.pinned?.session_id, sprouty.recent.length]).toEqual(['s_sprouty', 0]);
    const fern = drawerRows(s, { query: 'fern', expanded: false });
    expect([fern.pinned, fern.recent.length, fern.archived.map((r) => r.session_id)]).toEqual([null, 0, ['s_old']]);
    const bot = drawerRows(s, { query: 'bot', expanded: false });
    expect([bot.recent.length, bot.moreCount]).toEqual([5, 0]);
  });

  it('counts every DM as replyable until the Bot list arrives (an old group never); no pin without Sprouty', () => {
    const early = drawerRows({ ...s, bots: [], byId: {}, botsLoaded: false }, { query: '', expanded: true });
    expect(early.pinned).toBeNull();
    expect(early.archived.map((r) => r.session_id)).toEqual(['s_grp']);
    expect(early.recent).toHaveLength(rows.length - 1);
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
    store.set({
      conversations: [
        dm('s1', 'a', { attention: 'unread', unread_count: 3 }),
        dm('s2', 'b', { attention: 'unread', unread_count: 1 }),
      ],
    });
    store.get().noteRead('s1');
    expect(store.get().conversations.map((r) => [r.attention, r.unread_count])).toEqual([
      ['idle', 0],
      ['unread', 1],
    ]);
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

// ─── Task chats (spec 20261011-agent-first-class §5a) ────

describe('task chats', () => {
  const task = (sessionId: string, botId: string, partial: Partial<BotConversationSummary> = {}) =>
    dm(sessionId, botId, { kind: 'task', title: 'A chat', ...partial });

  it('are read with the threads (?kind=task), never drawn as threads; an older server’s DMs are left out', async () => {
    const store = makeStore({
      listConversations: vi.fn(async () => ({ ok: true as const, value: [dm('s_sprouty', 'bot_sprouty')] })),
      // an older server ignores `kind`: its answer is the threads again
      listTaskChats: vi.fn(async () => ({
        ok: true as const,
        value: [task('t1', 'bot_sprouty', { pending_requests: 2 }), dm('s_sprouty', 'bot_sprouty')],
      })),
    });
    await store.get().loadBots();
    await store.get().loadConversations();
    const s = store.get();
    expect(s.conversations.map((r) => r.session_id)).toEqual(['s_sprouty']);
    expect(s.taskChats.map((r) => r.session_id)).toEqual(['t1']);
    expect(s.pendingTotal).toBe(2);
    // a task row that slipped into the threads is still no thread
    const rows = drawerRows(
      { ...s, conversations: [...s.conversations, task('t2', 'bot_sprouty')] },
      {
        query: '',
        expanded: true,
      },
    );
    expect([
      rows.pinned?.session_id,
      ...rows.recent.map((r) => r.session_id),
      ...rows.archived.map((r) => r.session_id),
    ]).toEqual(['s_sprouty']);
  });

  it('a failed task list keeps the last answer (the threads still publish)', async () => {
    const listTaskChats = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: [task('t1', 'bot_sprouty')] })
      .mockResolvedValueOnce({ ok: false, status: 500, code: null });
    const store = makeStore({ listTaskChats });
    await store.get().loadConversations();
    await store.get().loadConversations();
    expect(store.get().taskChats.map((r) => r.session_id)).toEqual(['t1']);
    expect(store.get().conversationsLoaded).toBe(true);
    expect(store.get().error).toBeNull();
  });

  it('count for the ☰ badge (once per conversation), read and decide like threads, and go when deleted', async () => {
    const card = request('r1', 't1', { kind: 'approval' });
    const store = makeStore({
      decideRequest: vi.fn(async () => ({ ok: true as const, value: { ...card, status: 'resolved' as const } })),
    });
    store.set({
      conversations: [dm('s1', 'a', { attention: 'unread' })],
      taskChats: [
        task('t1', 'a', { pending_requests: 1, attention: 'needs_you' }),
        task('t2', 'a', { attention: 'unread', unread_count: 2 }),
        task('t3', 'a'),
      ],
      pendingRequests: [card],
      pendingTotal: 1,
    });
    expect(attentionCount(store.get(), null)).toBe(3);
    expect(attentionCount(store.get(), 't2')).toBe(2);
    expect(taskChatRow(store.get(), 't2')?.unread_count).toBe(2);
    expect(taskChatRow(store.get(), 'nope')).toBeNull();

    store.get().noteRead('t2');
    expect(taskChatRow(store.get(), 't2')).toMatchObject({ attention: 'idle', unread_count: 0 });
    await store.get().decide(card, { decision: 'approve' });
    expect(taskChatRow(store.get(), 't1')).toMatchObject({ pending_requests: 0, attention: 'idle' });
    expect(attentionCount(store.get(), null)).toBe(1);

    store.get().dropTaskChat('t3');
    expect(store.get().taskChats.map((r) => r.session_id)).toEqual(['t1', 't2']);
    const same = store.get();
    store.get().dropTaskChat('missing');
    expect(store.get().taskChats).toBe(same.taskChats);
  });
});

describe('public Agents (P4)', () => {
  const shared = (id: string, partial: Partial<SharedBotView> = {}): SharedBotView => ({
    id,
    name: id,
    role: 'Helper',
    description: '',
    avatar: {},
    template_key: null,
    owner: { id: 'u_owner', nickname: 'Jim' },
    dm_session_id: null,
    available: true,
    computer: false,
    ...partial,
  });
  const PUB = shared('bot_pub', { name: 'Handbook', dm_session_id: 's_pub' });
  const GONE = shared('bot_gone', { name: 'Old Helper', available: false, dm_session_id: 's_gone' });

  it('learns the shared Agents of the member’s DMs with the Bot list: names everywhere, never in `bots`', async () => {
    const listBots = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        // the member's own Agent wins over a shared entry with the same id (the server never sends one)
        value: { ...overview([SPROUTY]), shared_bots: [PUB, GONE, shared('bot_sprouty')] },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { ...overview([SPROUTY]), shared_bots: [{ ...PUB, available: false }] },
      });
    const store = makeStore({ listBots });
    await store.get().loadBots();
    const s = store.get();
    expect(Object.keys(s.shared).sort()).toEqual(['bot_gone', 'bot_pub']);
    expect(s.bots.map((b) => b.id)).toEqual(['bot_sprouty']);
    expect(s.byId.bot_pub).toMatchObject({ name: 'Handbook', status: 'active', user_id: 'u_owner' });
    expect(s.byId.bot_sprouty).toBe(SPROUTY);
    // a later answer updates what it names and keeps the rest (like archived Bots)
    await store.get().loadBots();
    expect(store.get().shared.bot_pub.available).toBe(false);
    expect(store.get().shared.bot_gone).toBe(GONE);
    expect(store.get().byId.bot_gone?.name).toBe('Old Helper');
    // an older server sends no `shared_bots`
    const older = makeStore();
    await older.get().loadBots();
    expect(older.get().shared).toEqual({});
  });

  it('files a DM with a shared Agent under Agents while it is offered, under Archived once it is not', () => {
    const s = data({
      bots: [SPROUTY],
      shared: { [PUB.id]: PUB, [GONE.id]: GONE },
      conversations: [dm('s_pub', 'bot_pub'), dm('s_gone', 'bot_gone')],
    });
    const rows = drawerRows(s, { query: '', expanded: true });
    expect(rows.recent.map((r) => r.session_id)).toEqual(['s_pub']);
    expect(rows.archived.map((r) => r.session_id)).toEqual(['s_gone']);
    // without `shared` (the widget) both are closed: the widget shows the member's own Agents
    const own = drawerRows({ ...s, shared: undefined }, { query: '', expanded: true });
    expect(own.recent).toEqual([]);
    expect(rowReplyable(s, dm('s_pub', 'bot_pub'))).toBe(true);
    expect(rowReplyable(s, dm('s_gone', 'bot_gone'))).toBe(false);
    expect(rowReplyable({ ...s, botsLoaded: false }, dm('s_gone', 'bot_gone'))).toBe(true);
    expect(rowSharedAgent(s, dm('s_pub', 'bot_pub'))).toBe(PUB);
    expect(rowSharedAgent(s, dm('s_sprouty', 'bot_sprouty'))).toBeNull();
    expect(rowSharedAgent(s, { kind: 'task', owner_bot_id: 'bot_pub' })).toBeNull();
  });

  it('reads the directory; a server without public Agents is asked once', async () => {
    const listAgents = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, code: null })
      .mockResolvedValueOnce({ ok: true, value: [PUB] })
      .mockResolvedValueOnce({ ok: false, status: 500, code: null })
      .mockResolvedValueOnce({ ok: false, status: 404, code: null });
    const store = makeStore({ listAgents });
    await store.get().loadDirectory();
    expect(store.get().directoryState).toBe('failed');
    await store.get().loadDirectory();
    expect([store.get().directoryState, store.get().directory]).toEqual(['loaded', [PUB]]);
    // a blip keeps the last answer
    await store.get().loadDirectory();
    expect([store.get().directoryState, store.get().directory]).toEqual(['loaded', [PUB]]);
    await store.get().loadDirectory();
    expect([store.get().directoryState, store.get().directory]).toEqual(['missing', []]);
    await store.get().loadDirectory();
    expect(listAgents).toHaveBeenCalledTimes(4);
  });

  it('starts the member’s own DM: the Agent is named at once, the lists re-read', async () => {
    const fresh = shared('bot_new', { name: 'Legal' });
    const startAgentConversation = vi.fn(async () => ({ ok: true as const, value: 's_new' }));
    const store = makeStore({ startAgentConversation });
    store.set({ directory: [fresh, PUB], directoryState: 'loaded' });
    const listBots = store.api.listBots as ReturnType<typeof vi.fn>;
    const before = listBots.mock.calls.length;
    expect(await store.get().startAgentChat(fresh)).toEqual({ ok: true, sessionId: 's_new' });
    expect(startAgentConversation).toHaveBeenCalledWith('bot_new');
    const s = store.get();
    expect(s.shared.bot_new).toMatchObject({ dm_session_id: 's_new', available: true });
    expect(s.byId.bot_new).toMatchObject({ name: 'Legal', dm_session_id: 's_new' });
    expect(s.directory.map((a) => a.dm_session_id)).toEqual(['s_new', 's_pub']);
    expect(listBots.mock.calls.length).toBe(before + 1);
    expect(store.api.listConversations).toHaveBeenCalled();
  });

  it('an Agent no longer offered leaves the directory; a blip leaves it be', async () => {
    const startAgentConversation = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 0, code: null, message: '' })
      .mockResolvedValueOnce({ ok: false, status: 404, code: null, message: 'Agent not found' });
    const listAgents = vi.fn(async () => ({ ok: true as const, value: [] }));
    const store = makeStore({ startAgentConversation, listAgents });
    store.set({ directory: [PUB], directoryState: 'loaded' });
    expect(await store.get().startAgentChat(PUB)).toEqual({ ok: false, reason: 'offline' });
    expect(store.get().directory).toEqual([PUB]);
    expect(await store.get().startAgentChat(PUB)).toEqual({ ok: false, reason: 'gone' });
    expect(store.get().directory).toEqual([]);
    expect(store.api.listAgents).toHaveBeenCalled();
  });

  it('rates a reply (the note trimmed, only when there is one) and remembers what went', async () => {
    const rateReply = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: undefined })
      .mockResolvedValueOnce({ ok: false, status: 404, code: null, message: '' })
      .mockResolvedValueOnce({ ok: true, value: undefined });
    const store = makeStore({ rateReply });
    expect(await store.get().rateReply('s_pub', 'm1', -1, '  wrong year ')).toBe(true);
    expect(rateReply).toHaveBeenLastCalledWith('s_pub', 'm1', { rating: -1, comment: 'wrong year' });
    expect(await store.get().rateReply('s_pub', 'm2', 1)).toBe(false);
    expect(store.get().ratings).toEqual({ m1: -1 });
    expect(await store.get().rateReply('s_pub', 'm1', 1, '')).toBe(true);
    expect(rateReply).toHaveBeenLastCalledWith('s_pub', 'm1', { rating: 1 });
    expect(store.get().ratings).toEqual({ m1: 1 });
    store.get().reset();
    expect([store.get().ratings, store.get().shared, store.get().directoryState]).toEqual([{}, {}, 'idle']);
  });

  it('takes a rating back (DELETE) and forgets it once that went; a refusal keeps it', async () => {
    const unrateReply = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 0, code: null, message: '' })
      .mockResolvedValueOnce({ ok: true, value: undefined });
    const store = makeStore({ unrateReply });
    store.set({ ratings: { m1: 1, m2: -1 } });
    expect(await store.get().unrateReply('s_pub', 'm1')).toBe(false);
    expect(store.get().ratings).toEqual({ m1: 1, m2: -1 });
    expect(await store.get().unrateReply('s_pub', 'm1')).toBe(true);
    expect(unrateReply).toHaveBeenLastCalledWith('s_pub', 'm1');
    expect(store.get().ratings).toEqual({ m2: -1 });
  });

  it('seeds the ratings from each page; one rated or taken back here keeps that choice', async () => {
    const reply = (id: string) => ({ id, role: 'assistant' as const, bot_id: 'bot_pub' });
    const store = makeStore({
      rateReply: vi.fn(async () => ({ ok: true as const, value: undefined })),
      unrateReply: vi.fn(async () => ({ ok: true as const, value: undefined })),
    });
    store.get().seedRatings([reply('m1'), reply('m2'), reply('m3')], { m1: 1, m2: -1 });
    expect(store.get().ratings).toEqual({ m1: 1, m2: -1 });
    // A later read: m2 taken back elsewhere, m3 rated elsewhere; m1 is on an older page this time.
    const before = store.get().ratings;
    store.get().seedRatings([reply('m2'), reply('m3')], { m3: 1 });
    expect(store.get().ratings).toEqual({ m1: 1, m3: 1 });
    // Nothing new: the same object (rows memoised on it stay put).
    const now = store.get().ratings;
    store.get().seedRatings([reply('m2'), reply('m3')], { m3: 1 });
    expect(store.get().ratings).toBe(now);
    expect(now).not.toBe(before);

    // Changed here: a page read before that landed does not undo it.
    await store.get().rateReply('s_pub', 'm2', 1);
    await store.get().unrateReply('s_pub', 'm3');
    store.get().seedRatings([reply('m2'), reply('m3')], { m3: 1 });
    expect(store.get().ratings).toEqual({ m1: 1, m2: 1 });
    // …until the store is reset (another account / station).
    store.get().reset();
    store.get().seedRatings([reply('m2'), reply('m3')], { m3: 1 });
    expect(store.get().ratings).toEqual({ m3: 1 });
  });
});
