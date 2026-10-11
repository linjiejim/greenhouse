/**
 * The Bots store's logic, React- and zustand-free so the root vitest can run it
 * with a fake API (./store.test.ts): the state shape, the actions (built by
 * `createBotsSlice(set, get, deps)` — ./store.ts binds them to zustand and the
 * real API) and the pure selectors every surface reads.
 *
 * One store because the drawer, the thread and the needs-you sheet render the
 * same facts at once (the web's bots-store.ts, same reason).
 * The server stays the source of truth — this is a cache that loads and WS
 * events refresh, never a place a decision is made. Two rules from the web
 * (spec §2.7.4):
 * - Loads are deduped, and a `generation` bumped by `reset()` (sign-out,
 *   station switch, Bots turned off) drops answers to requests made before it.
 * - `running` is the only client truth for "busy" (D14): the list's
 *   `attention: 'working'` only knows the API process that served it.
 *
 * Other members' public Agents (spec 20261011-agent-first-class P4): the ones in the member's DMs
 * (`shared_bots`) are kept by id in `shared` and also enter `byId` as stand-in entries
 * (./public-agents.ts `sharedAsBot`) so names and plants render everywhere; they are never in
 * `bots` (pickers, mentions, Settings → My Agents, new chats are the member's own). The directory
 * of public Agents offered to the member (`GET /api/agents`, "Browse Agents") is `directory`.
 */

import type {
  BotConversationSummary,
  BotRequestDecision,
  BotRequestErrorCode,
  BotRequestView,
  BotView,
  ComputerRuntimeView,
  SharedBotView,
} from '../shared/bots';
import { isSproutyBot } from '../shared/bots';
import type { DecideOutcome } from './contract';
import { feedbackBody, replyableIds, sharedAsBot, sharedById, startFailure, withConversation } from './public-agents';
import { classifyDecision } from './requests';
import { conversationCanReply } from './task-chats';
import { botsById, conversationBotIds, mergeArchived } from './vendor/web-helpers';

// ─── State ───────────────────────────────────────────────

export interface BotsData {
  /** Bumped by `reset()`: answers to requests made before it are dropped. */
  generation: number;
  /** Active Bots — pickers, mentions, the drawer. */
  bots: BotView[];
  /** Archived Bots: they never reply again, but history still needs their names and faces. */
  archived: BotView[];
  /**
   * Every Bot the member has had (archived first, active wins) — titles, speakers, cards — plus the
   * shared Agents of their DMs as stand-ins (`sharedAsBot`).
   */
  byId: Record<string, BotView>;
  /** Other members' public Agents in the member's DMs, by id (`GET /api/bots` `shared_bots`, P4). */
  shared: Record<string, SharedBotView>;
  /**
   * Public Agents offered to the member ("Browse Agents", `GET /api/agents`), in the server's order.
   * `directoryState`: `idle` until the first answer, `missing` on a server without them (404).
   */
  directory: SharedBotView[];
  directoryState: 'idle' | 'loaded' | 'failed' | 'missing';
  /** Replies the member rated on this device this app session (the server keeps no read of them). */
  ratings: Record<string, 1 | -1>;
  computer: ComputerRuntimeView | null;
  vaultAvailable: boolean;
  /** The Bot list arrived at least once — until then an unknown id is "not loaded yet", never "deleted". */
  botsLoaded: boolean;
  /** The threads: DMs and retired groups (`GET /api/bots/conversations`). */
  conversations: BotConversationSummary[];
  conversationsLoaded: boolean;
  /**
   * The member's task chats (`?kind=task`, read with the threads): never drawn as threads — the
   * drawer's chat rows (listed from the sessions) take their signals from here, and they count
   * for the ☰ badge.
   */
  taskChats: BotConversationSummary[];
  /** Every conversation's pending cards (`GET /api/bots/requests?status=pending`). */
  pendingRequests: BotRequestView[];
  /** Pending cards across every conversation (the overview, the list, the pending list or WS). */
  pendingTotal: number;
  /** sessionId → runId of every run generating now: the only client truth for "busy" (D14). */
  running: Record<string, string>;
  /** Decisions made on this device, by request id — only ever forward (see `mergeRequests`). */
  requestOverrides: Record<string, BotRequestView>;
  /** The thread on screen (focused + foreground), maintained by the thread engine. */
  visibleThread: string | null;
  /**
   * `forbidden` — a Bots route answered 403 (feature off / not internal): the
   * surfaces close for this app session; `missing` — `GET /api/bots` 404 (an
   * older server): everything closes, identity management included;
   * `failed` — the last load got no good answer (the drawer offers a retry).
   */
  error: 'forbidden' | 'missing' | 'failed' | null;
}

export interface BotsState extends BotsData {
  loadBots(): Promise<void>;
  loadConversations(): Promise<void>;
  loadPending(): Promise<void>;
  /**
   * Rebuild `running` from `GET /api/chat/runs` (after a reconnect, on each
   * socket-down poll). A conversation whose mark changed while the request was
   * out (a push, the open thread) keeps its live mark: the snapshot is older.
   */
  seedRuns(): Promise<void>;
  /** Sprouty's DM session id, bootstrapping it when missing — at most once per app session / station. */
  ensureSprouty(): Promise<string | null>;
  /** Re-read the Bot list when `ids` name a Bot never seen here (made elsewhere) — once per id. */
  ensureBotsKnown(ids: readonly string[]): Promise<void>;
  /** `GET /api/agents` — the public Agents offered to the member. */
  loadDirectory(): Promise<void>;
  /**
   * The member's own DM with a public Agent (`POST /api/agents/:id/conversation`, greeting
   * included): its session id, the Agent learned as shared at once; `gone` = no longer offered.
   */
  startAgentChat(
    agent: SharedBotView,
  ): Promise<{ ok: true; sessionId: string } | { ok: false; reason: 'gone' | 'offline' | 'failed' }>;
  /** Rate a public Agent's reply (👍 1 / 👎 -1, optional sentence); remembered in `ratings` when it went. */
  rateReply(sessionId: string, messageId: string, rating: 1 | -1, comment?: string | null): Promise<boolean>;
  setRunning(sessionId: string, runId: string | null): void;
  setPendingTotal(n: number): void;
  /**
   * A Bots route answered 403 outside the store (the thread engine, a sheet):
   * close the surfaces for this app session, like a 403 the store saw itself.
   */
  noteForbidden(): void;
  /** Optimistic: `unread` → `idle`, unread count → 0. */
  noteRead(sessionId: string): void;
  /** A task chat deleted here: gone from the signals and the badge at once. */
  dropTaskChat(sessionId: string): void;
  setVisibleThread(sessionId: string | null): void;
  /** `POST /api/bots/requests/:id`, classified; `ok` is remembered in `requestOverrides`. */
  decide(request: BotRequestView, body: BotRequestDecision): Promise<DecideOutcome>;
  reset(): void;
}

export function initialBotsData(generation = 0): BotsData {
  return {
    generation,
    bots: [],
    archived: [],
    byId: {},
    shared: {},
    directory: [],
    directoryState: 'idle',
    ratings: {},
    computer: null,
    vaultAvailable: false,
    botsLoaded: false,
    conversations: [],
    conversationsLoaded: false,
    taskChats: [],
    pendingRequests: [],
    pendingTotal: 0,
    running: {},
    requestOverrides: {},
    visibleThread: null,
    error: null,
  };
}

// ─── Actions ─────────────────────────────────────────────

export type SetBots = (partial: Partial<BotsData> | ((state: BotsState) => Partial<BotsData>)) => void;
export type GetBots = () => BotsState;

export interface BotsStoreDeps {
  api: Pick<
    typeof import('../api/bots'),
    | 'listBots'
    | 'bootstrapBots'
    | 'listConversations'
    | 'listTaskChats'
    | 'listRequests'
    | 'decideRequest'
    | 'listAgents'
    | 'startAgentConversation'
    | 'rateReply'
  > &
    Pick<typeof import('../api/chat'), 'listChatRuns'>;
  clock: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
}

/** How long `decide` waits before re-reading the pending list (several cards decided in a row share one read). */
export const PENDING_RELOAD_MS = 400;

/** Severity of `error`: a worse state is never downgraded by a later, milder failure. */
const ERROR_RANK = { failed: 1, forbidden: 2, missing: 3 } as const;

/**
 * One load in flight at a time. A call made while one is in flight shares a
 * single follow-up load that starts once it answers — the in-flight request
 * was sent before whatever prompted the call (a WS event, a Bot made
 * elsewhere), so its answer may already be stale.
 */
function coalesced(load: () => Promise<void>) {
  let current: Promise<void> | null = null;
  let next: Promise<void> | null = null;
  // Bumped by reset(): a follow-up queued before it must not start (or clear) anything after.
  let epoch = 0;
  const start = (): Promise<void> => {
    const run: Promise<void> = load().finally(() => {
      if (current === run) current = null;
    });
    current = run;
    return run;
  };
  return {
    run(): Promise<void> {
      if (!current) return start();
      if (!next) {
        const queuedIn = epoch;
        const followUp = () => {
          if (queuedIn !== epoch) return undefined;
          next = null;
          return start();
        };
        next = current.then(followUp, followUp);
      }
      return next;
    },
    /** Forget in-flight loads (reset): the next call starts fresh. */
    reset(): void {
      epoch += 1;
      current = null;
      next = null;
    },
  };
}

export function createBotsSlice(set: SetBots, get: GetBots, deps: BotsStoreDeps): BotsState {
  const { api, clock } = deps;
  // Unknown Bot ids a re-read was already spent on: still unknown after one really is gone.
  const refreshedForIds = new Set<string>();
  let sproutyOnce: Promise<string | null> | null = null;
  let pendingTimer: unknown = null;
  /** One set per `seedRuns` request in flight: the conversations whose busy mark changed meanwhile. */
  const seedsInFlight = new Set<Set<string>>();

  /** The thread surfaces are closed for this app session (403 / older server). */
  const closed = () => get().error === 'forbidden' || get().error === 'missing';
  const raise = (error: keyof typeof ERROR_RANK) => {
    const current = get().error;
    if (!current || ERROR_RANK[current] < ERROR_RANK[error]) set({ error });
  };
  /** A good answer clears a transient failure (never a 403 / 404 verdict). */
  const recovered = (): Partial<BotsData> => (get().error === 'failed' ? { error: null } : {});
  const failedWith = (status: number) => raise(status === 403 ? 'forbidden' : 'failed');

  const bots = coalesced(async () => {
    if (get().error === 'missing') return;
    const asked = get().generation;
    const result = await api.listBots();
    if (get().generation !== asked) return;
    if (!result.ok) {
      raise(result.status === 404 ? 'missing' : result.status === 403 ? 'forbidden' : 'failed');
      return;
    }
    // Sorted by each Bot's own status, so one archived mid-request lands on the right side.
    const everyone = [...result.value.bots, ...result.value.archived_bots];
    const active = everyone.filter((bot) => bot.status === 'active');
    const activeIds = new Set(active.map((bot) => bot.id));
    const archived = mergeArchived(
      get().archived,
      everyone.filter((bot) => bot.status !== 'active'),
    ).filter((bot) => !activeIds.has(bot.id));
    // Someone else's public Agents in the member's DMs: names and faces only (an older server sends none).
    // Like archived Bots, one this answer does not name is kept: a DM started here while the request
    // was out (`startAgentChat`) must not lose its name to an answer read before it existed.
    const ownIds = new Set(everyone.map((bot) => bot.id));
    const shared = {
      ...sharedById(Object.values(get().shared), ownIds),
      // (`shared_bots` is missing from servers without public Agents: `sharedById` reads that as none.)
      ...sharedById(result.value.shared_bots, ownIds),
    };
    set({
      bots: active,
      archived,
      shared,
      byId: Object.fromEntries([
        ...Object.values(shared).map((view) => [view.id, sharedAsBot(view)] as const),
        ...botsById([...archived, ...active]),
      ]),
      computer: result.value.computer,
      vaultAvailable: result.value.vault_available,
      pendingTotal: result.value.pending_requests,
      botsLoaded: true,
      ...recovered(),
    });
  });

  const conversations = coalesced(async () => {
    if (closed()) return;
    const asked = get().generation;
    const [result, tasks] = await Promise.all([api.listConversations(), api.listTaskChats()]);
    if (get().generation !== asked) return;
    if (!result.ok) {
      failedWith(result.status);
      return;
    }
    // The task chats are a secondary list: a blip keeps the last answer (an older server has none).
    const taskChats = tasks.ok ? tasks.value.filter((row) => row.kind === 'task') : get().taskChats;
    const rows = [...result.value, ...taskChats];
    // Learn Bots made elsewhere before publishing, so no row flashes as "Deleted Bot".
    const speakers = rows.flatMap((row) => (row.last_message?.bot_id ? [row.last_message.bot_id] : []));
    await get().ensureBotsKnown([...rows.flatMap(conversationBotIds), ...speakers]);
    if (get().generation !== asked) return;
    set({
      conversations: result.value,
      taskChats,
      conversationsLoaded: true,
      // As fresh as the lists; the WS push overrides it between loads.
      pendingTotal: rows.reduce((sum, row) => sum + row.pending_requests, 0),
      ...recovered(),
    });
  });

  const pending = coalesced(async () => {
    if (closed()) return;
    const asked = get().generation;
    const result = await api.listRequests('pending');
    if (get().generation !== asked) return;
    if (!result.ok) {
      // A secondary list: only a 403 verdict matters, a blip keeps the last answer.
      if (result.status === 403) raise('forbidden');
      return;
    }
    set({ pendingRequests: result.value, pendingTotal: result.value.length });
  });

  const directory = coalesced(async () => {
    if (closed() || get().directoryState === 'missing') return;
    const asked = get().generation;
    const result = await api.listAgents();
    if (get().generation !== asked) return;
    if (result.ok) set({ directory: result.value, directoryState: 'loaded' });
    // A server without public Agents: the entry stays away for this app session.
    else if (result.status === 404) set({ directory: [], directoryState: 'missing' });
    // A blip keeps the last answer; a 403 is the threads' verdict too (they say it themselves).
    else if (get().directoryState === 'idle') set({ directoryState: 'failed' });
  });

  const reloadPendingSoon = () => {
    if (pendingTimer !== null) clock.clearTimeout(pendingTimer);
    pendingTimer = clock.setTimeout(() => {
      pendingTimer = null;
      void pending.run();
    }, PENDING_RELOAD_MS);
  };

  /** A card this device settled: remembered, and dropped from the pending counts at once. */
  const settled = (before: BotRequestView, after: BotRequestView) =>
    set((state) => {
      const next: Partial<BotsData> = { requestOverrides: { ...state.requestOverrides, [after.id]: after } };
      if (before.status !== 'pending' || after.status === 'pending') return next;
      next.pendingRequests = state.pendingRequests.filter((request) => request.id !== after.id);
      next.pendingTotal = Math.max(0, state.pendingTotal - 1);
      const decided = (row: BotConversationSummary): BotConversationSummary => {
        if (row.session_id !== after.session_id || row.pending_requests === 0) return row;
        const left = row.pending_requests - 1;
        // The next list load says what it really is (unread / working); "needs you" is over.
        return {
          ...row,
          pending_requests: left,
          attention: left === 0 && row.attention === 'needs_you' ? 'idle' : row.attention,
        };
      };
      next.conversations = state.conversations.map(decided);
      next.taskChats = state.taskChats.map(decided);
      return next;
    });

  return {
    ...initialBotsData(),

    loadBots: () => bots.run(),
    loadConversations: () => conversations.run(),
    loadPending: () => pending.run(),
    loadDirectory: () => directory.run(),

    async startAgentChat(agent) {
      const asked = get().generation;
      const result = await api.startAgentConversation(agent.id);
      if (!result.ok) {
        if (get().generation === asked && result.status === 404) {
          // No longer offered: drop it from the list now, and re-read what is.
          set((state) => ({ directory: state.directory.filter((entry) => entry.id !== agent.id) }));
          void get().loadDirectory();
        }
        return { ok: false, reason: startFailure(result) };
      }
      const sessionId = result.value;
      if (get().generation === asked) {
        // The thread names it at once; the lists catch up with its DM and greeting.
        const view = withConversation(agent, sessionId);
        // (The directory never lists the member's own Agents.)
        set((state) => ({
          shared: { ...state.shared, [view.id]: view },
          byId: { ...state.byId, [view.id]: sharedAsBot(view) },
          directory: state.directory.map((entry) => (entry.id === view.id ? view : entry)),
        }));
        void get().loadBots();
        void get().loadConversations();
      }
      return { ok: true, sessionId };
    },

    async rateReply(sessionId, messageId, rating, comment) {
      const asked = get().generation;
      const result = await api.rateReply(sessionId, messageId, feedbackBody(rating, comment));
      if (!result.ok) return false;
      if (get().generation === asked) set((state) => ({ ratings: { ...state.ratings, [messageId]: rating } }));
      return true;
    },

    async seedRuns() {
      if (closed()) return;
      const asked = get().generation;
      const touched = new Set<string>();
      seedsInFlight.add(touched);
      try {
        const runs = await api.listChatRuns();
        if (get().generation !== asked || !runs) return;
        set((state) => {
          const running: Record<string, string> = {};
          for (const run of runs) if (!touched.has(run.session_id)) running[run.session_id] = run.run_id;
          // Changed while the request was out (a run's end or start pushed, the open thread reading one): newer.
          for (const sessionId of touched) {
            const live = state.running[sessionId];
            if (live !== undefined) running[sessionId] = live;
          }
          return { running };
        });
      } finally {
        seedsInFlight.delete(touched);
      }
    },

    async ensureSprouty() {
      if (closed()) return null;
      if (!get().botsLoaded) await get().loadBots();
      if (closed()) return null;
      const known = sproutyDm(get());
      if (known) return known;
      if (!sproutyOnce) {
        const asked = get().generation;
        const once = api.bootstrapBots().then((result) => {
          if (get().generation !== asked) return null;
          if (!result.ok) {
            if (result.status === 403) raise('forbidden');
            return null;
          }
          // Pin Sprouty right away; the lists catch up with its DM and greeting.
          const bot = { ...result.value.bot, dm_session_id: result.value.dm_session_id };
          set((state) => {
            const active = [...state.bots.filter((candidate) => candidate.id !== bot.id), bot];
            return { bots: active, byId: { ...state.byId, [bot.id]: bot } };
          });
          void get().loadBots();
          void get().loadConversations();
          return result.value.dm_session_id;
        });
        sproutyOnce = once;
        // A failure may be retried (the next drawer visit asks again).
        void once.then((sid) => {
          if (sid === null && sproutyOnce === once) sproutyOnce = null;
        });
      }
      return sproutyOnce;
    },

    async ensureBotsKnown(ids) {
      const { byId, botsLoaded } = get();
      // Before the first load every id is unknown; that load answers them all.
      if (!botsLoaded) return;
      const unknown = [...new Set(ids)].filter((id) => !byId[id] && !refreshedForIds.has(id));
      if (unknown.length === 0) return;
      for (const id of unknown) refreshedForIds.add(id);
      await get().loadBots();
    },

    setRunning(sessionId, runId) {
      for (const touched of seedsInFlight) touched.add(sessionId);
      set((state) => {
        if (runId === null) {
          if (!(sessionId in state.running)) return {};
          const { [sessionId]: _gone, ...rest } = state.running;
          return { running: rest };
        }
        return state.running[sessionId] === runId ? {} : { running: { ...state.running, [sessionId]: runId } };
      });
    },

    setPendingTotal(n) {
      set({ pendingTotal: Math.max(0, n) });
    },

    noteForbidden() {
      raise('forbidden');
    },

    noteRead(sessionId) {
      const read = (row: BotConversationSummary): BotConversationSummary =>
        row.session_id === sessionId && row.attention === 'unread'
          ? { ...row, attention: 'idle', ...(row.unread_count === undefined ? {} : { unread_count: 0 }) }
          : row;
      set((state) => ({ conversations: state.conversations.map(read), taskChats: state.taskChats.map(read) }));
    },

    dropTaskChat(sessionId) {
      set((state) =>
        state.taskChats.some((row) => row.session_id === sessionId)
          ? { taskChats: state.taskChats.filter((row) => row.session_id !== sessionId) }
          : {},
      );
    },

    setVisibleThread(sessionId) {
      if (get().visibleThread !== sessionId) set({ visibleThread: sessionId });
    },

    async decide(request, body) {
      const asked = get().generation;
      const result = await api.decideRequest(request.id, body);
      const current = get().generation === asked;
      if (result.ok) {
        if (current) {
          settled(request, result.value);
          reloadPendingSoon();
          // A new Bot / a new instructions version: the directory changed.
          if (request.kind === 'bot_create' || request.kind === 'instructions_update') void get().loadBots();
        }
        return { kind: 'ok', request: result.value };
      }
      if (current && result.status === 403) raise('forbidden');
      if (classifyDecision(result.status, result.code) === 'stale') {
        if (current) reloadPendingSoon();
        return { kind: 'stale' };
      }
      return {
        kind: 'refused',
        status: result.status,
        // The server's vocabulary (packages/types BotRequestErrorCode); an unknown code reads as generic copy.
        code: result.code as BotRequestErrorCode | null,
        message: result.message,
      };
    },

    reset() {
      bots.reset();
      conversations.reset();
      pending.reset();
      directory.reset();
      refreshedForIds.clear();
      sproutyOnce = null;
      if (pendingTimer !== null) clock.clearTimeout(pendingTimer);
      pendingTimer = null;
      set(initialBotsData(get().generation + 1));
    },
  };
}

// ─── Selectors (pure) ────────────────────────────────────

/** The member's built-in main Bot, once the list is in (it is never archived). */
export function sproutyBot(s: Pick<BotsData, 'bots'>): BotView | null {
  return s.bots.find(isSproutyBot) ?? null;
}

/** Sprouty's DM: the Bot's own pointer, else its row in the list. */
export function sproutyDm(s: Pick<BotsData, 'bots' | 'conversations'>): string | null {
  const sprouty = sproutyBot(s);
  if (!sprouty) return null;
  if (sprouty.dm_session_id) return sprouty.dm_session_id;
  return s.conversations.find((row) => row.kind === 'direct' && row.owner_bot_id === sprouty.id)?.session_id ?? null;
}

export interface DrawerRows {
  /** Sprouty's DM, always first; null until it exists (or when the search hides it). */
  pinned: BotConversationSummary | null;
  /** Conversations someone can still reply in, server order (newest activity first) — never re-sorted by attention. */
  recent: BotConversationSummary[];
  /** Replyable rows hidden behind "Show All" (0 when expanded or searching). */
  moreCount: number;
  /** Conversations nobody can reply in any more (an archived DM Bot, every old group chat). */
  archived: BotConversationSummary[];
}

/**
 * The drawer's Bots section: Sprouty pinned, then the replyable conversations (a shared public
 * Agent's DM among them while it is still offered — one no longer offered is archived)
 * in the server's order (spatial memory beats attention sorting), the first
 * `recent` of them unless expanded; read-only ones go to "Archived". A search
 * filters every part by title, member names and the last preview, and never
 * collapses. Before the Bot list arrives every DM counts as replyable; an old
 * group chat is a closed record (group chats were retired) whatever the list says.
 * Task chats are never threads here — they are the chats section's rows.
 */
export function drawerRows(
  s: Pick<BotsData, 'bots' | 'byId' | 'botsLoaded' | 'conversations'> & Partial<Pick<BotsData, 'shared'>>,
  o: { query: string; expanded: boolean; recent?: number },
): DrawerRows {
  const limit = o.recent ?? 5;
  const query = o.query.trim().toLocaleLowerCase();
  const matches = (row: BotConversationSummary) => !query || searchText(s.byId, row).includes(query);
  const pinnedSid = sproutyDm(s);
  // A shared Agent's DM is open while it is still offered (without `shared`, like the widget: closed).
  const activeIds = replyableIds(s.bots, s.shared);
  const replyable = (row: BotConversationSummary) =>
    row.kind === 'direct' && (!s.botsLoaded || conversationCanReply(row, activeIds));
  const threads = s.conversations.filter((row) => row.kind !== 'task');

  const pinnedRow = pinnedSid ? (threads.find((row) => row.session_id === pinnedSid) ?? null) : null;
  const rest = threads.filter((row) => row.session_id !== pinnedSid && matches(row));
  const open = rest.filter(replyable);
  const collapse = !query && !o.expanded && open.length > limit;
  return {
    pinned: pinnedRow && matches(pinnedRow) ? pinnedRow : null,
    recent: collapse ? open.slice(0, limit) : open,
    moreCount: collapse ? open.length - limit : 0,
    archived: rest.filter((row) => !replyable(row)),
  };
}

/** What a drawer search looks at: the group title, every member's name, the last preview. */
function searchText(byId: Record<string, BotView>, row: BotConversationSummary): string {
  const names = [...conversationBotIds(row)].map((id) => byId[id]?.name ?? '');
  return [row.title ?? '', ...names, row.last_message?.preview ?? ''].join('\n').toLocaleLowerCase();
}

/**
 * A row's one signal: "needs you" (pending cards) beats unread; unread is not
 * shown for the conversation on screen. `working` (from `running`) rewrites the
 * preview line instead of being a badge; the server's `attention: 'working'`
 * is ignored (D14).
 */
export function rowSignal(
  s: Pick<BotsData, 'running'>,
  row: BotConversationSummary,
  currentSid: string | null,
): { badge: 'needs_you' | 'unread' | null; needsYouCount: number; working: boolean } {
  const needsYouCount = Math.max(0, row.pending_requests);
  const badge =
    needsYouCount > 0 ? 'needs_you' : row.attention === 'unread' && row.session_id !== currentSid ? 'unread' : null;
  return { badge, needsYouCount, working: row.session_id in s.running };
}

/** Other conversations — threads and task chats — that need the member or have something unread: the ☰ badge. */
export function attentionCount(s: Pick<BotsData, 'conversations' | 'taskChats'>, excludeSid: string | null): number {
  const counted = new Set<string>();
  for (const row of [...s.conversations, ...s.taskChats]) {
    if (row.session_id === excludeSid || counted.has(row.session_id)) continue;
    if (row.pending_requests > 0 || row.attention === 'unread') counted.add(row.session_id);
  }
  return counted.size;
}

/** Can anyone still reply in this conversation (a row's sleeping plant)? Before the Bot list arrives: yes. */
export function rowReplyable(
  s: Pick<BotsData, 'bots' | 'botsLoaded' | 'shared'>,
  row: Pick<BotConversationSummary, 'kind' | 'owner_bot_id'>,
): boolean {
  return row.kind !== 'group' && (!s.botsLoaded || conversationCanReply(row, replyableIds(s.bots, s.shared)));
}

/** The DM's shared Agent (someone else's public Agent), if the row is one. */
export function rowSharedAgent(
  s: Pick<BotsData, 'shared'>,
  row: Pick<BotConversationSummary, 'kind' | 'owner_bot_id'>,
): SharedBotView | null {
  return (row.kind === 'direct' && row.owner_bot_id && s.shared[row.owner_bot_id]) || null;
}

/** A task chat's summary (the drawer's chat row signals), when the store has read it. */
export function taskChatRow(s: Pick<BotsData, 'taskChats'>, sessionId: string): BotConversationSummary | null {
  return s.taskChats.find((row) => row.session_id === sessionId) ?? null;
}
