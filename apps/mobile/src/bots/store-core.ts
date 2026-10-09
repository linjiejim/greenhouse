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
 */

import type {
  BotConversationSummary,
  BotRequestDecision,
  BotRequestErrorCode,
  BotRequestView,
  BotView,
  ComputerRuntimeView,
} from '../shared/bots';
import { isSproutyBot } from '../shared/bots';
import type { DecideOutcome } from './contract';
import { classifyDecision } from './requests';
import { botsById, conversationBotIds, conversationReplyable, mergeArchived } from './vendor/web-helpers';

// ─── State ───────────────────────────────────────────────

export interface BotsData {
  /** Bumped by `reset()`: answers to requests made before it are dropped. */
  generation: number;
  /** Active Bots — pickers, mentions, the invite list. */
  bots: BotView[];
  /** Archived Bots: they never reply again, but history still needs their names and faces. */
  archived: BotView[];
  /** Every Bot the member has had (archived first, active wins) — titles, speakers, cards. */
  byId: Record<string, BotView>;
  computer: ComputerRuntimeView | null;
  vaultAvailable: boolean;
  /** The Bot list arrived at least once — until then an unknown id is "not loaded yet", never "deleted". */
  botsLoaded: boolean;
  conversations: BotConversationSummary[];
  conversationsLoaded: boolean;
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
  setRunning(sessionId: string, runId: string | null): void;
  setPendingTotal(n: number): void;
  /**
   * A Bots route answered 403 outside the store (the thread engine, a sheet):
   * close the surfaces for this app session, like a 403 the store saw itself.
   */
  noteForbidden(): void;
  /** Optimistic: `unread` → `idle`, unread count → 0. */
  noteRead(sessionId: string): void;
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
    computer: null,
    vaultAvailable: false,
    botsLoaded: false,
    conversations: [],
    conversationsLoaded: false,
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
    'listBots' | 'bootstrapBots' | 'listConversations' | 'listRequests' | 'decideRequest'
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
    set({
      bots: active,
      archived,
      byId: Object.fromEntries(botsById([...archived, ...active])),
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
    const result = await api.listConversations();
    if (get().generation !== asked) return;
    if (!result.ok) {
      failedWith(result.status);
      return;
    }
    // Learn Bots made elsewhere before publishing, so no row flashes as "Deleted Bot".
    const speakers = result.value.flatMap((row) => (row.last_message?.bot_id ? [row.last_message.bot_id] : []));
    await get().ensureBotsKnown([...result.value.flatMap(conversationBotIds), ...speakers]);
    if (get().generation !== asked) return;
    set({
      conversations: result.value,
      conversationsLoaded: true,
      // As fresh as the list; the WS push overrides it between loads.
      pendingTotal: result.value.reduce((sum, row) => sum + row.pending_requests, 0),
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
      next.conversations = state.conversations.map((row) => {
        if (row.session_id !== after.session_id || row.pending_requests === 0) return row;
        const left = row.pending_requests - 1;
        // The next list load says what it really is (unread / working); "needs you" is over.
        return {
          ...row,
          pending_requests: left,
          attention: left === 0 && row.attention === 'needs_you' ? 'idle' : row.attention,
        };
      });
      return next;
    });

  return {
    ...initialBotsData(),

    loadBots: () => bots.run(),
    loadConversations: () => conversations.run(),
    loadPending: () => pending.run(),

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
      set((state) => ({
        conversations: state.conversations.map((row) =>
          row.session_id === sessionId && row.attention === 'unread'
            ? { ...row, attention: 'idle', ...(row.unread_count === undefined ? {} : { unread_count: 0 }) }
            : row,
        ),
      }));
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
 * The drawer's Bots section: Sprouty pinned, then the replyable conversations
 * in the server's order (spatial memory beats attention sorting), the first
 * `recent` of them unless expanded; read-only ones go to "Archived". A search
 * filters every part by title, member names and the last preview, and never
 * collapses. Before the Bot list arrives every DM counts as replyable; an old
 * group chat is a closed record (group chats were retired) whatever the list says.
 */
export function drawerRows(
  s: Pick<BotsData, 'bots' | 'byId' | 'botsLoaded' | 'conversations'>,
  o: { query: string; expanded: boolean; recent?: number },
): DrawerRows {
  const limit = o.recent ?? 5;
  const query = o.query.trim().toLocaleLowerCase();
  const matches = (row: BotConversationSummary) => !query || searchText(s.byId, row).includes(query);
  const pinnedSid = sproutyDm(s);
  const activeIds = new Set(s.bots.map((bot) => bot.id));
  const replyable = (row: BotConversationSummary) =>
    row.kind === 'direct' && (!s.botsLoaded || conversationReplyable(row, activeIds));

  const pinnedRow = pinnedSid ? (s.conversations.find((row) => row.session_id === pinnedSid) ?? null) : null;
  const rest = s.conversations.filter((row) => row.session_id !== pinnedSid && matches(row));
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

/** Other conversations that need the member or have something unread — the ☰ badge. */
export function attentionCount(s: Pick<BotsData, 'conversations'>, excludeSid: string | null): number {
  return s.conversations.filter(
    (row) => row.session_id !== excludeSid && (row.pending_requests > 0 || row.attention === 'unread'),
  ).length;
}
