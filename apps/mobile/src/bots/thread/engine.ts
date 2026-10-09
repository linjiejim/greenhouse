/**
 * `ThreadEngine` — one open Bots thread: its transcript (REST pages), the run
 * being read (NDJSON, possibly several Bots taking turns), the member's sends
 * in flight, stops, and card decisions (spec docs/specs/20261008-mobile-bots.md
 * §2.7.5–2.7.7, decisions D5–D7, D9, D13, D14). Pure TypeScript: every
 * dependency (API, realtime, store, clock) is injected, so the root vitest
 * drives every race with fakes (./engine.test.ts). The screen reads it through
 * `useBotThread` (../use-bot-thread.ts → `useSyncExternalStore`).
 *
 * Freshness follows the web (apps/web/src/components/bots/use-bot-conversation.ts):
 * pushes only say "X changed" and the transcript is re-read over REST; a run's
 * own events arrive on its stream; when the run settles, the persisted rows
 * replace the live segments in one commit (deduped by message id — never a
 * double). What mobile adds, because it has no tab-wide SessionManager:
 *
 * - One reader at a time (`chain`). Every stream source — a POST's 200 stream,
 *   a re-attach — is queued; a new run's stream waits until the previous
 *   reader has seen `finish` AND settled (reloaded, cleared). Its bytes wait in
 *   the response meanwhile.
 * - The send latch. The server announces a run on the socket (`chat:run
 *   running`) before the POST that started it answers 200 (chain.ts:582). While
 *   a send is in flight such a push is only remembered (`latchRunId`), never
 *   attached to: the POST's own stream is that run's reader.
 * - Single-flight attach. At most one "probe, then re-attach" at a time, and
 *   the reader check is repeated after the probe answers.
 * - Run identity. A second source for a run already being read (or waiting),
 *   or one already read to its end here, is cancelled, never queued to replay
 *   it again — checked whenever a run id becomes known (enqueue, a POST's
 *   probe, a resume, its turn on the chain). A dropped transport resumes with
 *   `after=lastSeq` only on the same run id (a new run's seq starts at 0),
 *   otherwise the run is read again from its start — unless a waiting reader
 *   (or the send in flight) owns that run: then this reader settles and lets
 *   it. Resumes count failures in a row (a source that delivered anything
 *   starts the count again; a re-attach this device forced is none), and when
 *   they run out a last probe decides: a run still going keeps its busy mark.
 * - Probes answer for the moment they were asked: an "idle" answer only clears
 *   the busy mark it saw, and a run announced while a probe was out is looked
 *   for again once it answers.
 * - The newest page never leaves a hole: when it does not reach what is loaded
 *   (more than a page landed meanwhile), it replaces it — paging up refills.
 * - Try Again never re-posts while a run goes on: a message delivered to a busy
 *   run waits in its inbox (not in the transcript) until the next turn, so the
 *   bubble waits as queued; only a run that ends without it brings Try Again
 *   back.
 * - "Busy" is only ever a real signal (D14): a local reader, a run the socket
 *   or a probe reported, or a queued send this device could not attach to
 *   (`remoteBusy` — the run lives in another API slot): a bounded reload
 *   cadence, never a fake typing indicator.
 * - Read receipts only while visible (focused + foreground; a sheet on top
 *   does not count). The polling fallback only runs while visible and only
 *   when the socket has been down for a while (./polling.ts) — zero polling
 *   while it is open.
 * - Typing out: the reveal front (./reveal.ts) — one Bot types at a time;
 *   stream events only touch the accumulator and a ~33 ms tick publishes at
 *   most one snapshot; anything else is published on the next microtask.
 *
 * Privacy: the transcript lives in memory only (./cache.ts LRU, never on disk),
 * nothing here logs.
 */

import type { ChatRunProbe, RunStreamEvent } from '../../api/chat';
import type { BotConversationDetail, BotMessage, BotRequestDecision, BotRequestView } from '../../shared/bots';
import type { ConversationPage } from '../../shared/bots-wire';
import type {
  DecideOutcome,
  MobilePending,
  RealtimeEvent,
  SendInput,
  SendOutcome,
  ThreadController,
  ThreadDeps,
  ThreadEffect,
  ThreadRun,
  ThreadSnapshot,
} from '../contract';
import { mergeRequests } from '../requests';
import { pickUpQueued } from '../vendor/transcript';
import { conversationBotIds, maxSeq, mergeLatest, PAGE_SIZE, settlePending } from '../vendor/web-helpers';
import { threadCache, type ThreadCache } from './cache';
import { createFallbackPoller, type FallbackPoller } from './polling';
import {
  presentSegments,
  revealAll,
  revealFront,
  revealSegment,
  revealStep,
  TICK_MS,
  type PresentCache,
} from './reveal';
import { applyRunEvent, emptyRunState, settleRun, type RunState } from './run-state';

// ─── Timings (spec §2.7.3 / §2.7.6) ──────────────────────

/** Re-attach attempts after a transport drop before the run is treated as gone (the transcript is reloaded). */
export const MAX_RESUMES = 5;
/** Back in the foreground with no event (not even the server's 15 s ping) for this long = a dead socket. */
export const STALE_MS = 20_000;
/** `bots:conversation` pushes for the open thread collapse into one reload. */
export const CONVERSATION_RELOAD_MS = 250;
/** After a card decision: probe for the run it may have started (bot_create / login / takeover / task_start). */
export const DECIDE_PROBE_MS = 400;
/** A queued send nobody here can attach to: reload after this, then every `REMOTE_BUSY_EVERY_MS`… */
export const REMOTE_BUSY_FIRST_MS = 3_000;
export const REMOTE_BUSY_EVERY_MS = 5_000;
/** …for at most this long. */
export const REMOTE_BUSY_MAX_MS = 60_000;
/** Polling (socket down, thread visible): probe the run this often, reload the newest page every Nth beat. */
export const POLL_PROBE_MS = 8_000;
export const POLL_RELOAD_EVERY = 3;

const resumeDelay = (attempt: number) => Math.min(800 * attempt, 4_000);

/** Rejection of a read the reader itself cut short (detach, a forced re-attach). */
const ABORTED: unique symbol = Symbol('aborted');

/** HTTP status carried by a stream failure (`ChatHttpError`), 0 when none. */
function httpStatus(error: unknown): number {
  if (!error || typeof error !== 'object') return 0;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : 0;
}

/** The next event, or a rejection as soon as `signal` aborts (a silent socket never answers `next()`). */
function nextOrAbort<T>(it: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) return Promise.reject(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    it.next().then(
      (step) => {
        signal.removeEventListener('abort', onAbort);
        resolve(step);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Persisted rows are written once; a re-read returns equal copies. Reusing the
 * loaded object keeps the transcript rows (memoised by source object) still.
 */
function sameMessage(a: BotMessage, b: BotMessage): boolean {
  return (
    a.id === b.id &&
    a.seq === b.seq &&
    a.content === b.content &&
    a.created_at === b.created_at &&
    a.reasoning === b.reasoning &&
    a.pipeline.length === b.pipeline.length &&
    a.images.length === b.images.length &&
    (a.bot_event?.kind ?? null) === (b.bot_event?.kind ?? null)
  );
}

function shallowEqual<T extends object>(a: T, b: T): boolean {
  for (const key of Object.keys(a) as Array<keyof T>) if (a[key] !== b[key]) return false;
  return true;
}

/** Members in order — a change (a Bot joining, a removal) lifts a read-only refusal. */
const memberKey = (conversation: BotConversationDetail) =>
  conversation.members.map((member) => member.bot_id).join(',');

/** One reader of one run's stream. */
interface Reader {
  kind: 'post' | 'attach';
  /** Null until known (a POST's run is learned from the latch or a probe). */
  runId: string | null;
  byMe: boolean;
  /** A POST's opened 200 stream; null for an attach (opened when its turn comes). */
  source: AsyncGenerator<RunStreamEvent> | null;
  /** Aborts the current transport (the POST's own request, or the latest re-attach). */
  transport: AbortController;
  /** Let go for good (dispose, a duplicate, a local stop). */
  detached: boolean;
  /** Let go on purpose but still settle (reload, clear): a hard stop that could not reach the server, or `no_run`. */
  letGo: boolean;
  /** …and show its open segments as stopped. */
  stopped: boolean;
  /** This device cut the transport to re-attach (a dead socket on the way back): no failure. */
  forced: boolean;
  lastEventAt: number;
  /** Events read from every source so far (pings included) — progress between drops. */
  events: number;
}

/** The run being read (or replayed), with what of it is on screen. */
interface LiveRun {
  key: string;
  runId: string | null;
  state: RunState;
  /** Characters of each segment's text on screen (./reveal.ts). */
  shown: number[];
  byMe: boolean;
  replaying: boolean;
  /** Interjection turns already matched to queued sends — each turn once, even when replayed again. */
  matched: number;
}

type AttachResult = 'attached' | 'idle' | 'busy' | 'failed';
/**
 * How a reader's turn ended. `done` — the run's `finish` (or declared error)
 * was read; `ended` — the run is over without that being read here (404, no
 * run, another run took the slot); `gone` — let go without knowing (a stop);
 * `alive` — re-attaching kept failing while the run goes on (settle what is on
 * screen, keep the busy mark); `detached` — dropped (dispose, a duplicate).
 */
type ReadOutcome = 'done' | 'ended' | 'gone' | 'alive' | 'detached';
type ReloadResult = 'ok' | 'failed';

export class ThreadEngine implements ThreadController {
  readonly sessionId: string;
  private readonly deps: ThreadDeps;
  private readonly cache: ThreadCache;

  private started = false;
  private disposed = false;
  private visible = false;
  private foreground = true;

  // Transcript
  private load: ThreadSnapshot['load'] = 'loading';
  private refreshFailed = false;
  private conversation: BotConversationDetail | null = null;
  private members = '';
  private messages: BotMessage[] = [];
  private hasMore = false;
  private earlier: ThreadSnapshot['earlier'] = 'idle';
  private memoryStates: Record<string, string> = {};

  // Sends
  private pending: MobilePending[] = [];
  private readonly mentions = new Map<string, string[]>();
  private sendsInFlight = 0;
  /** A `chat:run running` that arrived while a send was in flight: probably that send's own run. */
  private latchRunId: string | null = null;
  private readOnly: ThreadSnapshot['readOnly'] = null;
  private runError: string | null = null;
  /** Retried while a run was going and found in no transcript yet: maybe waiting in that run's inbox. */
  private readonly unconfirmed = new Set<string>();

  // The run
  private run: LiveRun | null = null;
  private reader: Reader | null = null;
  private waiting: Reader[] = [];
  private chain: Promise<void> = Promise.resolve();
  private attaching: Promise<AttachResult> | null = null;
  /** An attach was turned away because a reader was busy: look again once it has settled. */
  private recheck = false;
  /** A run was announced while an attach's probe was out (its answer may predate it): look again after. */
  private attachAgain = false;
  /** …that run, when known: no second look if it is being read by then. */
  private attachAgainRun: string | null = null;
  /** The last run read here to its end (or known to be over): never read again. */
  private lastReadRunId: string | null = null;
  /** Interrupt requests in flight (the button already says "Stopping"). */
  private softAsked = 0;
  /** A soft stop taken for a run no reader here has yet (it shows until a reader replays it, or the run ends). */
  private softRemote = false;
  private hardStopping = false;
  private remoteBusy: { clientId: string; since: number; timer: unknown } | null = null;
  /** The probe after a card decision is scheduled (one per burst of decisions). */
  private decideProbe = false;

  // Reloads
  private ticket = 0;
  private latestReload: Promise<ReloadResult> | null = null;

  // Timers & subscriptions
  private revealTimer: unknown = null;
  private revealWaiters: Array<() => void> = [];
  private conversationTimer: unknown = null;
  private readonly timers = new Set<unknown>();
  private readonly poller: FallbackPoller;
  private readonly unsubscribes: Array<() => void> = [];

  // Publishing
  private readonly listeners = new Set<() => void>();
  private readonly effectListeners = new Set<(e: ThreadEffect) => void>();
  private snap: ThreadSnapshot;
  private publishQueued = false;
  private presentCache: PresentCache = [];
  private runMemo: {
    run: LiveRun;
    runId: string | null;
    state: RunState;
    shown: number[];
    replaying: boolean;
    out: ThreadRun;
  } | null = null;
  private requestsMemo: {
    rest: readonly BotRequestView[] | undefined;
    live: readonly BotRequestView[] | undefined;
    overrides: Record<string, BotRequestView>;
    out: ReadonlyMap<string, BotRequestView>;
  } | null = null;
  private seenRunning: string | null;
  private seenOverrides: Record<string, BotRequestView>;

  constructor(sessionId: string, deps: ThreadDeps, options: { cache?: ThreadCache } = {}) {
    this.sessionId = sessionId;
    this.deps = deps;
    this.cache = options.cache ?? threadCache;
    const state = deps.store.getState();
    this.seenRunning = state.running[sessionId] ?? null;
    this.seenOverrides = state.requestOverrides;
    this.poller = createFallbackPoller({
      realtime: deps.realtime,
      clock: deps.clock,
      intervalMs: POLL_PROBE_MS,
      tick: (n) => this.pollBeat(n),
    });
    this.snap = this.compose();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  // ─── ThreadController ───────────────────────────────────

  getSnapshot = (): ThreadSnapshot => this.snap;

  /** The first subscriber opens the thread (no I/O happens before something listens). */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.start();
    return () => {
      this.listeners.delete(listener);
    };
  };

  onEffect(listener: (e: ThreadEffect) => void): () => void {
    this.effectListeners.add(listener);
    return () => {
      this.effectListeners.delete(listener);
    };
  }

  /** Open the thread (idempotent; `subscribe` calls it). */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.unsubscribes.push(this.deps.realtime.on((e) => this.onRealtime(e)));
    this.unsubscribes.push(this.deps.store.subscribe(() => this.onStore()));
    void this.open();
  }

  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return;
    this.visible = visible;
    const store = this.deps.store.getState();
    if (visible) {
      store.setVisibleThread(this.sessionId);
      // Whatever landed while something covered the thread is on screen now.
      this.markRead();
    } else if (store.visibleThread === this.sessionId) {
      store.setVisibleThread(null);
    }
    this.poller.setActive(this.visible && this.foreground);
  }

  setForeground(active: boolean): void {
    if (this.disposed || active === this.foreground) return;
    this.foreground = active;
    this.poller.setActive(this.visible && this.foreground);
    // Backgrounded: nothing to do — the run goes on server-side, and the
    // transport is left to the OS; coming back checks on it.
    if (!active || !this.started) return;
    const reader = this.reader;
    if (reader && !this.run?.state.finished) {
      // Reading, but silent past the server's keepalive: a dead socket — re-attach (resume rules).
      if (this.deps.clock.now() - reader.lastEventAt > STALE_MS) {
        reader.forced = true;
        reader.transport.abort();
      }
      return;
    }
    // Pick up what happened meanwhile: a run started elsewhere, reports that landed.
    void this.ensureAttached();
    void this.reloadLatest().then((result) => {
      if (result === 'ok') this.markRead();
    });
  }

  async send(input: SendInput): Promise<SendOutcome> {
    if (this.disposed) return { ok: false, kind: 'not_delivered' };
    const now = this.deps.clock.now();
    const clientId = `send-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.mentions.set(clientId, input.mentions);
    this.runError = null;
    this.pending = [
      ...this.pending,
      {
        clientId,
        content: input.text,
        images: input.images,
        status: 'sending',
        // A busy run: the message sits after the turns it saw.
        afterSegment: this.run ? this.run.state.segments.length : 0,
        baseSeq: maxSeq(this.messages),
      },
    ];
    this.publish();
    return this.post(clientId);
  }

  /**
   * Try a "Not Delivered" send again — after a reload, because the POST may
   * have reached the server and only its answer was lost: then the persisted
   * copy settles the bubble. Not in the transcript is not "never received"
   * while a run goes on: a message delivered to a busy run (202) waits in its
   * inbox until the next turn — so then the bubble waits as queued and the
   * run is read; Try Again comes back only if the run ends without the copy
   * (`reviewUnconfirmed`). A reload or probe that fails sends nothing (it could
   * not tell). One race is left for a server-side idempotency key: a run that
   * ends right after the probe, its inbox starting a new one.
   */
  async retry(clientId: string): Promise<SendOutcome> {
    if (this.disposed) return { ok: false, kind: 'not_delivered' };
    if (!this.findPending(clientId)) return { ok: true, startedRun: false };
    const reloaded = await this.reloadLatest();
    if (this.disposed) return { ok: false, kind: 'not_delivered' };
    if (!this.findPending(clientId)) return { ok: true, startedRun: false };
    if (reloaded !== 'ok') return { ok: false, kind: 'not_delivered' };
    const probe = await this.deps.api.getChatRun(this.sessionId);
    if (this.disposed) return { ok: false, kind: 'not_delivered' };
    if (!this.findPending(clientId)) return { ok: true, startedRun: false };
    if (!probe) return { ok: false, kind: 'not_delivered' };
    if (probe.active && probe.run) {
      this.unconfirmed.add(clientId);
      this.patchPending(clientId, { failed: false, status: 'queued' });
      const attach = await this.ensureAttached(probe);
      // Nobody here reads it (yet): reload for a while — the copy, or the run's end, shows up.
      if (!this.disposed && attach !== 'attached' && this.findPending(clientId)) this.startRemoteBusy(clientId);
      return { ok: true, startedRun: false };
    }
    this.patchPending(clientId, { failed: false, status: 'sending' });
    return this.post(clientId);
  }

  discard(clientId: string): void {
    if (!this.findPending(clientId)) return;
    this.pending = this.pending.filter((send) => send.clientId !== clientId);
    this.mentions.delete(clientId);
    this.unconfirmed.delete(clientId);
    if (this.remoteBusy?.clientId === clientId) this.stopRemoteBusy();
    this.publish();
  }

  stop(mode: 'next' | 'soft' | 'hard' = 'next'): void {
    if (this.disposed) return;
    const snap = this.compose();
    if (!snap.runActive) return;
    let step: 'soft' | 'hard';
    if (mode === 'next') {
      if (snap.stopPhase === 'hard') return;
      step = snap.stopPhase === 'soft' ? 'hard' : 'soft';
    } else {
      step = mode;
    }
    if (step === 'soft') void this.softStop();
    else void this.hardStop();
  }

  /**
   * "Handle Now" on a queued message: the current step finishes, the turn
   * ends, the run reads the waiting message next. `no_run` = it already
   * finished — the message is read anyway; only a refusal is reported.
   */
  async handleNow(clientId: string): Promise<'ok' | 'refused'> {
    this.patchPending(clientId, { nudged: true });
    const outcome = await this.deps.api.interruptChatRun(this.sessionId);
    if (outcome !== 'refused') return 'ok';
    this.patchPending(clientId, { nudged: false });
    return 'refused';
  }

  async decide(request: BotRequestView, body: BotRequestDecision): Promise<DecideOutcome> {
    const outcome = await this.deps.store.getState().decide(request, body);
    if (this.disposed) return outcome;
    if (outcome.kind === 'ok') {
      // A settled sign-in / hand-back / new Bot / task wakes a Bot up server-side.
      this.probeAfterDecision();
    } else if (outcome.kind === 'stale') {
      void this.reload();
    }
    return outcome;
  }

  async loadEarlier(): Promise<void> {
    const oldest = this.messages[0];
    if (this.disposed || !oldest || !this.hasMore || this.earlier === 'loading') return;
    this.earlier = 'loading';
    this.publish();
    const result = await this.deps.api.getConversation(this.sessionId, { beforeSeq: oldest.seq, limit: PAGE_SIZE });
    if (this.disposed) return;
    if (!result.ok) {
      this.earlier = 'error';
      this.publish();
      return;
    }
    const page = result.value;
    await this.deps.store.getState().ensureBotsKnown(page.messages.flatMap((m) => (m.bot_id ? [m.bot_id] : [])));
    if (this.disposed) return;
    if (this.messages[0]?.seq !== oldest.seq) {
      // The newest page replaced what was loaded meanwhile (`applyLatest`, a hole): this page sits below
      // a gap now — drop it; the next "load earlier" asks below the new oldest row.
      this.earlier = 'idle';
      this.publish();
      return;
    }
    const known = new Set(this.messages.map((message) => message.id));
    this.messages = [...page.messages.filter((message) => !known.has(message.id)), ...this.messages].sort(
      (a, b) => a.seq - b.seq,
    );
    this.hasMore = page.has_more;
    if (page.memory_states) this.memoryStates = { ...this.memoryStates, ...page.memory_states };
    this.earlier = 'idle';
    this.publish();
  }

  async reload(): Promise<void> {
    const wasReady = this.load === 'ready';
    const result = await this.reloadLatest();
    if (result !== 'ok') return;
    if (!wasReady) void this.ensureAttached();
    this.markRead();
  }

  dismissRunError(): void {
    if (this.runError === null) return;
    this.runError = null;
    this.publish();
  }

  /** Let go of everything local; a run goes on server-side. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Sends in flight are left to finish: aborting one could lose the member's message.
    for (const reader of [this.reader, ...this.waiting]) if (reader) this.detach(reader);
    this.clearTimer(this.revealTimer);
    this.revealTimer = null;
    this.clearTimer(this.conversationTimer);
    this.conversationTimer = null;
    this.stopRemoteBusy();
    for (const timer of this.timers) this.deps.clock.clearTimeout(timer);
    this.timers.clear();
    this.poller.dispose();
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    const store = this.deps.store.getState();
    if (store.visibleThread === this.sessionId) store.setVisibleThread(null);
    this.saveCache();
    this.resolveRevealWaiters();
  }

  // ─── Opening & reloading ────────────────────────────────

  private async open(): Promise<void> {
    const store = this.deps.store.getState();
    const cached = this.cache.get(this.sessionId, store.generation);
    if (cached) {
      this.conversation = cached.conversation;
      this.members = memberKey(cached.conversation);
      this.messages = cached.messages;
      this.hasMore = cached.hasMore;
      this.memoryStates = cached.memoryStates;
      this.load = 'ready';
      this.publish();
    }
    const markBefore = this.mark();
    const probing = this.deps.api.getChatRun(this.sessionId);
    const loaded = await this.reloadLatest();
    const probe = await probing;
    if (this.disposed) return;
    if (loaded !== 'ok' && this.load !== 'ready') return;
    if (probe?.active) void this.ensureAttached(probe);
    else if (probe && !this.noteIdle(markBefore, probe.run?.run_id ?? null)) void this.ensureAttached();
    if (loaded === 'ok') this.markRead();
  }

  /**
   * Re-read the newest page. Answers to older calls are dropped (a newer
   * reload answers for them). `quiet`: apply without publishing — the caller
   * publishes it together with its own change (a run settling).
   */
  private reloadLatest(o: { quiet?: boolean } = {}): Promise<ReloadResult> {
    const ticket = ++this.ticket;
    const reload = this.fetchLatest(ticket, o.quiet === true);
    this.latestReload = reload;
    return reload;
  }

  private async fetchLatest(ticket: number, quiet: boolean): Promise<ReloadResult> {
    const superseded = () => (this.latestReload && ticket !== this.ticket ? this.latestReload : 'failed');
    const result = await this.deps.api.getConversation(this.sessionId, { limit: PAGE_SIZE });
    if (this.disposed) return 'failed';
    if (ticket !== this.ticket) return superseded();
    if (!result.ok) {
      this.loadFailed(result.status);
      if (!quiet) this.publish();
      return 'failed';
    }
    const page = result.value;
    // A member or speaker this device has not heard of (a Bot made elsewhere): learn it before showing it.
    const speakers = page.messages.flatMap((message) => (message.bot_id ? [message.bot_id] : []));
    await this.deps.store.getState().ensureBotsKnown([...conversationBotIds(page.conversation), ...speakers]);
    if (this.disposed) return 'failed';
    if (ticket !== this.ticket) return superseded();
    this.applyLatest(page);
    this.reviewUnconfirmed();
    if (!quiet) this.publish();
    return 'ok';
  }

  private loadFailed(status: number): void {
    if (status === 404) {
      this.load = 'not_found';
    } else if (status === 403) {
      this.load = 'forbidden';
      this.deps.store.getState().noteForbidden();
    } else if (this.load === 'ready') {
      // A refresh failing after a good load keeps the transcript on screen.
      this.refreshFailed = true;
    } else {
      this.load = 'error';
    }
  }

  private applyLatest(page: ConversationPage): void {
    const loaded = this.messages;
    const previous = new Map(loaded.map((message) => [message.id, message]));
    const latest = page.messages.map((message) => {
      const known = previous.get(message.id);
      return known && sameMessage(known, message) ? known : message;
    });
    // More than a page landed since the last load (backgrounded, reopened from the cache): the newest
    // page does not reach what is loaded. Merging would leave a hole paging up can never fill (it only
    // asks below the oldest row) — start over from the newest page; paging up refills from there.
    const floor = latest.length > 0 ? Math.min(...latest.map((message) => message.seq)) : Infinity;
    const gapped = page.has_more && loaded.length > 0 && floor > maxSeq(loaded) + 1;
    const merged = gapped ? latest : mergeLatest(loaded, latest);
    const unchanged = merged.length === loaded.length && merged.every((message, index) => message === loaded[index]);
    if (!unchanged) this.messages = merged;
    // Paged up already: the newest page's `has_more` speaks for the page, not for what is loaded.
    this.hasMore = !gapped && loaded.length > page.messages.length ? this.hasMore : page.has_more;
    this.conversation = page.conversation;
    const members = memberKey(page.conversation);
    if (members !== this.members) {
      this.members = members;
      this.readOnly = null;
    }
    if (page.memory_states) this.memoryStates = { ...this.memoryStates, ...page.memory_states };
    this.settleSends();
    this.load = 'ready';
    this.refreshFailed = false;
    // A run nobody here reads any more (it ended while detached, or its settle could not reload): the rows are the truth now.
    if (this.run && !this.reader) this.run = null;
    this.saveCache();
  }

  /** Drop sends whose persisted copy is in (one-to-one, oldest first; includes `sending`). */
  private settleSends(): void {
    if (this.pending.length === 0) return;
    const left = settlePending(this.pending, this.messages) as MobilePending[];
    if (left.length === this.pending.length) return;
    const kept = new Set(left.map((send) => send.clientId));
    for (const send of this.pending) {
      if (kept.has(send.clientId)) continue;
      this.mentions.delete(send.clientId);
      this.unconfirmed.delete(send.clientId);
    }
    this.pending = left;
    if (this.remoteBusy && !kept.has(this.remoteBusy.clientId)) this.stopRemoteBusy();
  }

  private saveCache(): void {
    if (!this.conversation || this.load !== 'ready') return;
    this.cache.put(this.sessionId, this.deps.store.getState().generation, {
      conversation: this.conversation,
      messages: this.messages,
      hasMore: this.hasMore,
      memoryStates: this.memoryStates,
    });
  }

  private markRead(): void {
    if (this.disposed || !this.visible || !this.foreground || this.load !== 'ready') return;
    void this.deps.api.markConversationRead(this.sessionId).then((ok) => {
      if (ok && !this.disposed) this.deps.store.getState().noteRead(this.sessionId);
    });
  }

  // ─── Sending ────────────────────────────────────────────

  private async post(clientId: string): Promise<SendOutcome> {
    const send = this.findPending(clientId);
    if (!send) return { ok: true, startedRun: false };
    const transport = new AbortController();
    this.sendsInFlight += 1;
    let result: Awaited<ReturnType<ThreadDeps['api']['openBotsChat']>>;
    try {
      result = await this.deps.api.openBotsChat({
        sessionId: this.sessionId,
        content: send.content,
        images: send.images,
        mentions: this.mentions.get(clientId) ?? [],
        signal: transport.signal,
      });
    } catch {
      result = { kind: 'error', status: 0, code: null, message: '' };
    } finally {
      this.sendsInFlight -= 1;
    }
    // The latch only speaks for this POST's window: whatever it holds is used (or dropped) now.
    const latched = this.latchRunId;
    this.latchRunId = null;
    if (this.disposed) {
      if (result.kind === 'stream') {
        transport.abort();
        void result.events.return(undefined).catch(() => {});
      }
      return result.kind === 'error' ? { ok: false, kind: 'not_delivered' } : { ok: true, startedRun: false };
    }

    if (result.kind === 'stream') {
      // This request started the run: its stream is the run's one reader.
      this.patchPending(clientId, { status: 'sent' });
      const reader = this.newReader({ kind: 'post', runId: latched, byMe: true, source: result.events, transport });
      this.enqueue(reader);
      // The run's id, for resuming and dedupe — right after the 200 the session's run slot is ours.
      if (!reader.runId) {
        void this.deps.api.getChatRun(this.sessionId).then((probe) => {
          if (reader.runId || reader.detached || !probe?.run) return;
          reader.runId = probe.run.run_id;
          if (this.dropDuplicate(reader)) return;
          if (this.reader === reader && this.run && !this.run.runId) {
            this.run.runId = reader.runId;
            this.noteOwnRunning(reader.runId);
            this.publish();
          }
        });
      }
      return { ok: true, startedRun: true };
    }

    if (result.kind === 'queued') {
      // Delivered while busy: read between Bot turns. It stays where it was sent.
      this.patchPending(clientId, { status: 'queued' });
      const attach = await this.ensureAttached();
      if (!this.disposed && (attach === 'idle' || attach === 'failed') && this.findPending(clientId)) {
        this.startRemoteBusy(clientId);
      }
      return { ok: true, startedRun: false };
    }

    // A run was announced while this POST was out (the server took it after all, or another run started): read it.
    if (latched) void this.ensureAttached();

    if (result.status === 0) {
      // No answer: keep the bubble (still `sending`, so a reload can still settle it) for a retry.
      this.patchPending(clientId, { failed: true });
      return { ok: false, kind: 'not_delivered' };
    }

    this.removePending(clientId);
    if (result.status === 409 && (result.code === 'bot_archived' || result.code === 'group_closed')) {
      this.readOnly = result.code;
      this.publish();
      void this.deps.store.getState().loadBots();
      void this.reload();
      return { ok: false, kind: 'read_only', code: result.code };
    }
    this.publish();
    return { ok: false, kind: 'rejected', status: result.status, message: result.message };
  }

  private findPending(clientId: string): MobilePending | undefined {
    return this.pending.find((send) => send.clientId === clientId);
  }

  private patchPending(clientId: string, patch: Partial<MobilePending>): void {
    let changed = false;
    this.pending = this.pending.map((send) => {
      if (send.clientId !== clientId) return send;
      changed = true;
      return { ...send, ...patch };
    });
    if (changed) this.publish();
  }

  private removePending(clientId: string): void {
    this.pending = this.pending.filter((send) => send.clientId !== clientId);
    this.mentions.delete(clientId);
    this.unconfirmed.delete(clientId);
    if (this.remoteBusy?.clientId === clientId) this.stopRemoteBusy();
  }

  /**
   * Sends Try Again found no copy of while a run was going (`retry`): once
   * nothing runs any more and a reload still has no copy, the server never got
   * them — "Not Delivered" again, so Try Again comes back. `settling`: the
   * reader whose run just ended is still on the chain.
   */
  private reviewUnconfirmed(settling = false): void {
    if (this.unconfirmed.size === 0) return;
    if ((this.reader && !settling) || this.waiting.length > 0 || this.remoteBusy || this.sendsInFlight > 0) return;
    if (this.mark() !== null) return;
    const ids = [...this.unconfirmed];
    this.unconfirmed.clear();
    for (const clientId of ids) {
      if (this.findPending(clientId)) this.patchPending(clientId, { failed: true, status: 'sending' });
    }
  }

  /**
   * A queued send while no reader here can attach (the run lives in another
   * API slot): say "working" — static, never fake typing — and reload until the
   * message settles, for a bounded time.
   */
  private startRemoteBusy(clientId: string): void {
    if (this.reader || this.waiting.length > 0) return;
    this.stopRemoteBusy();
    const busy = { clientId, since: this.deps.clock.now(), timer: null as unknown };
    this.remoteBusy = busy;
    const step = (delay: number) => {
      busy.timer = this.deps.clock.setTimeout(() => {
        busy.timer = null;
        void this.reloadLatest().then(() => {
          if (this.remoteBusy !== busy) return;
          if (this.deps.clock.now() + REMOTE_BUSY_EVERY_MS - busy.since > REMOTE_BUSY_MAX_MS) {
            this.stopRemoteBusy();
            this.reviewUnconfirmed();
            this.publish();
            return;
          }
          step(REMOTE_BUSY_EVERY_MS);
        });
      }, delay);
    };
    step(REMOTE_BUSY_FIRST_MS);
    this.publish();
  }

  private stopRemoteBusy(): void {
    const busy = this.remoteBusy;
    if (!busy) return;
    this.remoteBusy = null;
    if (busy.timer !== null) this.deps.clock.clearTimeout(busy.timer);
    if (!this.busyReading() && this.deps.store.getState().running[this.sessionId] === undefined) {
      this.softRemote = false;
    }
  }

  // ─── Stopping ───────────────────────────────────────────

  /**
   * Soft stop: the step in flight finishes (and is kept), then a waiting
   * message is answered or the run ends. Marked as taken only if no newer turn
   * started meanwhile (that turn used the request up). `no_run`: it already
   * ended — let go quietly; refused: stop now instead.
   */
  private async softStop(): Promise<void> {
    if (this.hardStopping) return;
    const run = this.run;
    const turnStarts = run?.state.turnStarts ?? 0;
    this.softAsked += 1;
    this.publish();
    const outcome = await this.deps.api.interruptChatRun(this.sessionId);
    this.softAsked -= 1;
    if (this.disposed) return;
    if (outcome === 'refused') {
      void this.hardStop();
      return;
    }
    if (outcome === 'no_run') {
      this.letGo(false);
      this.publish();
      return;
    }
    if (run && this.run === run && this.reader) {
      if (!run.state.finished && run.state.turnStarts === turnStarts && !run.state.interrupting) {
        run.state = { ...run.state, interrupting: true };
      }
    } else if (!run && !this.reader) {
      // Nobody here reads that run yet: attach to watch it wind down.
      this.softRemote = true;
      void this.ensureAttached();
    }
    this.publish();
  }

  /**
   * Hard stop: the server stops now and persists the partial; the transport
   * stays open so the stream ends with its `finish`. If the server cannot be
   * reached, let go locally and show the run as stopped.
   */
  private async hardStop(): Promise<void> {
    if (this.hardStopping) return;
    this.hardStopping = true;
    this.publish();
    const ok = await this.deps.api.stopChatRun(this.sessionId);
    if (this.disposed) return;
    const reader = this.reader;
    if (reader && !this.run?.state.finished) {
      if (!ok) this.letGo(true);
      return;
    }
    // No reader here (a run in another slot, or nothing left): done.
    this.hardStopping = false;
    this.letGo(false);
    this.publish();
  }

  /** Stop reading (settling what is on screen) and forget any busy signal for this thread. */
  private letGo(stopped: boolean): void {
    const reader = this.reader;
    if (reader && !reader.detached) {
      reader.letGo = true;
      reader.stopped = stopped;
      this.detach(reader);
      return;
    }
    this.softRemote = false;
    this.stopRemoteBusy();
    this.clearRunning(null);
    void this.reload();
  }

  // ─── Readers ────────────────────────────────────────────

  private newReader(
    r: Pick<Reader, 'kind' | 'runId' | 'byMe'> & Partial<Pick<Reader, 'source' | 'transport'>>,
  ): Reader {
    return {
      kind: r.kind,
      runId: r.runId,
      byMe: r.byMe,
      source: r.source ?? null,
      transport: r.transport ?? new AbortController(),
      detached: false,
      letGo: false,
      stopped: false,
      forced: false,
      lastEventAt: this.deps.clock.now(),
      events: 0,
    };
  }

  private busyReading(): boolean {
    return this.reader !== null || this.waiting.length > 0;
  }

  private readsRun(runId: string): boolean {
    return [this.reader, ...this.waiting].some((reader) => reader && !reader.detached && reader.runId === runId);
  }

  /**
   * Probe the session's run and attach when one is live and nobody here reads
   * it. Single flight; the "nobody reads it, no send in flight" check is
   * repeated after the probe answers. `known`: a probe the caller already has.
   */
  private ensureAttached(known?: ChatRunProbe | null): Promise<AttachResult> {
    if (this.disposed) return Promise.resolve('busy');
    if (this.attaching) return this.attaching;
    if (this.busyReading()) {
      this.recheck = true;
      return Promise.resolve('busy');
    }
    if (this.sendsInFlight > 0) return Promise.resolve('busy');
    const attempt = (async (): Promise<AttachResult> => {
      const markBefore = this.mark();
      const probe = known !== undefined ? known : await this.deps.api.getChatRun(this.sessionId);
      if (this.disposed) return 'busy';
      if (this.busyReading()) {
        this.recheck = true;
        return 'busy';
      }
      if (this.sendsInFlight > 0) return 'busy';
      if (!probe) return 'failed';
      if (!probe.active || !probe.run) {
        // A run announced after this probe was asked: its "idle" is older than that — ask again.
        if (!this.noteIdle(markBefore, probe.run?.run_id ?? null)) this.lookAgain(this.mark());
        return 'idle';
      }
      this.enqueue(this.newReader({ kind: 'attach', runId: probe.run.run_id, byMe: false }));
      return 'attached';
    })();
    this.attaching = attempt;
    void attempt.finally(() => {
      if (this.attaching === attempt) this.attaching = null;
      this.attachAgainIfAsked();
    });
    return attempt;
  }

  /** A `chat:run running` push: attach — or, with a probe already out (it may predate the run), look again after it. */
  private attachForPush(runId: string): void {
    if (this.attaching) {
      this.lookAgain(runId);
      return;
    }
    void this.ensureAttached();
  }

  private lookAgain(runId: string | null): void {
    this.attachAgain = true;
    this.attachAgainRun = runId;
  }

  private attachAgainIfAsked(): void {
    if (!this.attachAgain || this.disposed || this.attaching) return;
    const runId = this.attachAgainRun ?? this.mark();
    this.attachAgain = false;
    this.attachAgainRun = null;
    // The attempt that just answered already reads the run announced meanwhile.
    if (runId !== null && this.readsRun(runId)) return;
    void this.ensureAttached();
  }

  /**
   * The server says nothing runs here: forget a stale busy mark (nobody reads
   * one locally). The answer is only as fresh as the probe: a mark that changed
   * after it was asked (`markBefore`) — and is not the probed run itself — is a
   * newer run; it stays, and false asks the caller to look again.
   */
  private noteIdle(markBefore: string | null, probed: string | null): boolean {
    if (this.busyReading()) return true;
    const mark = this.mark();
    if (mark !== null && mark !== markBefore && mark !== probed) return false;
    this.softRemote = false;
    this.clearRunning(null);
    this.publish();
    return true;
  }

  private enqueue(reader: Reader): void {
    // A second reader of a run already being read (or waiting) would replay it again: cancel it.
    if (reader.runId && this.readsRun(reader.runId)) {
      this.detach(reader);
      return;
    }
    this.waiting.push(reader);
    this.chain = this.chain.then(() => this.pump(reader));
    this.publish();
  }

  private detach(reader: Reader): void {
    if (reader.detached) return;
    reader.detached = true;
    reader.transport.abort();
    // A POST stream never read: release it.
    if (reader.source && this.reader !== reader) void reader.source.return(undefined).catch(() => {});
  }

  /**
   * A reader that just learned its run id (a POST's probe) duplicates another:
   * of two readers of one run the later in the chain goes; a run already read
   * to its end here is never read again (a reader already reading it settles
   * quietly). True when `reader` was let go.
   */
  private dropDuplicate(reader: Reader): boolean {
    const runId = reader.runId;
    if (!runId) return false;
    const chain = [this.reader, ...this.waiting].filter((r): r is Reader => r !== null && !r.detached);
    const at = chain.indexOf(reader);
    if (at < 0) return false;
    if (runId === this.lastReadRunId) {
      if (this.reader === reader) {
        // Settle quietly — and clear only that run's busy mark, never a newer one.
        reader.letGo = true;
        if (this.run && !this.run.runId) this.run.runId = runId;
      }
      this.detach(reader);
      return true;
    }
    const twin = chain.findIndex((other, index) => index !== at && other.runId === runId);
    if (twin < 0) return false;
    if (twin < at) {
      this.detach(reader);
      return true;
    }
    this.detach(chain[twin]);
    return false;
  }

  /** A reader waiting its turn owns this run: its id, or a POST's 200 (the newest claim on the slot); or the send in flight it was announced to. */
  private ownedElsewhere(reader: Reader, runId: string): boolean {
    if (this.sendsInFlight > 0 && this.latchRunId === runId) return true;
    return this.waiting.some(
      (other) => other !== reader && !other.detached && (other.runId === runId || (other.kind === 'post' && other.runId === null)),
    );
  }

  /** One reader's turn on the chain: read its run to the end, then settle. */
  private async pump(reader: Reader): Promise<void> {
    this.waiting = this.waiting.filter((waiting) => waiting !== reader);
    if (this.disposed) return;
    // Its run was read to its end here meanwhile (by a reader that switched onto it): nothing left to show.
    if (reader.runId !== null && reader.runId === this.lastReadRunId) this.detach(reader);
    if (!reader.detached) {
      this.reader = reader;
      try {
        await this.consume(reader);
      } catch {
        /* consume settles every path itself */
      } finally {
        if (this.reader === reader) this.reader = null;
      }
      if (this.disposed) return;
    }
    this.publish();
    // A run that started while this one was winding down (or was pushed meanwhile).
    const running = this.deps.store.getState().running[this.sessionId];
    if (this.recheck || (running && running !== reader.runId)) {
      this.recheck = false;
      void this.ensureAttached();
    }
  }

  private async consume(reader: Reader): Promise<void> {
    this.beginRun(reader, { reload: true });
    let source: AsyncIterable<RunStreamEvent> | null =
      reader.source ?? this.deps.api.streamChatRun(this.sessionId, -1, reader.transport.signal);
    /** Failed re-attaches in a row: a source that delivered anything (even a ping) starts the count again. */
    let attempts = 0;
    let outcome: ReadOutcome;
    const cut = (): ReadOutcome => (reader.letGo && !this.disposed ? 'gone' : 'detached');
    for (;;) {
      if (source) {
        const seen = reader.events;
        try {
          await this.read(reader, source);
          if (reader.detached) throw ABORTED;
          const state = this.run?.state;
          if (state?.finished || state?.serverError) {
            outcome = 'done';
            break;
          }
          throw new Error('stream closed before finish');
        } catch (error) {
          if (reader.detached || this.disposed) {
            outcome = cut();
            break;
          }
          // Re-attaching found no run (404): it ended — the persisted rows are final.
          if (httpStatus(error) === 404) {
            outcome = 'ended';
            break;
          }
          // A failure the server declared: its partial is persisted — never retried.
          if (this.run?.state.serverError) {
            outcome = 'done';
            break;
          }
          // The transport drops as a hard stop lands: expected, quietly settled.
          if (this.hardStopping) {
            outcome = 'gone';
            break;
          }
          // It worked for a while and dropped (a long run, a network handover): not a failure streak.
          if (reader.events > seen) attempts = 0;
        }
      }
      // The transport dropped (or a forced re-attach): the run goes on server-side — resume it.
      const forced = reader.forced;
      reader.forced = false;
      if (!forced) {
        if (attempts >= MAX_RESUMES) {
          outcome = await this.lastLook(reader);
          if (outcome === 'detached') outcome = cut();
          break;
        }
        attempts += 1;
      }
      await this.sleep(forced ? 0 : resumeDelay(attempts));
      if (reader.detached || this.disposed) {
        outcome = cut();
        break;
      }
      const probe = await this.deps.api.getChatRun(this.sessionId);
      if (reader.detached || this.disposed) {
        outcome = cut();
        break;
      }
      if (!probe) {
        // No answer (offline): what is on screen stays; ask again on the next attempt.
        source = null;
        continue;
      }
      if (!probe.run) {
        outcome = 'ended';
        break;
      }
      reader.transport = new AbortController();
      reader.forced = false;
      reader.lastEventAt = this.deps.clock.now();
      if (reader.runId !== null && probe.run.run_id === reader.runId) {
        // Same run: replay only what was missed.
        source = this.deps.api.streamChatRun(this.sessionId, this.run?.state.lastSeq ?? -1, reader.transport.signal);
        continue;
      }
      // Another run in the slot, which a waiting reader (or the send in flight) owns: this one is over —
      // settle it and let that reader read the new run (switching here would read it twice).
      if (this.ownedElsewhere(reader, probe.run.run_id)) {
        outcome = 'ended';
        break;
      }
      // Another run (its seq starts at 0) — or ours, never identified: read it from its start.
      await this.switchRun(reader, probe.run.run_id);
      if (reader.detached || this.disposed) {
        outcome = cut();
        break;
      }
      source = this.deps.api.streamChatRun(this.sessionId, -1, reader.transport.signal);
    }

    if (outcome === 'detached') return;
    const run = this.run;
    if ((outcome === 'done' || outcome === 'ended') && reader.runId) this.lastReadRunId = reader.runId;
    if (run) {
      const stopped = this.hardStopping || reader.stopped;
      run.state = settleRun(run.state, stopped ? 'stopped' : run.state.serverError ? 'error' : 'completed');
      if (run.state.serverError && !stopped) this.runError = run.state.serverError;
      // Still going server-side: the busy mark stays (Stop with it); a push, a resync or polling picks it up.
      if (outcome !== 'alive') this.clearRunning(run.runId);
      if (outcome === 'done') {
        // Let the typing catch up before the persisted rows take over.
        this.publish();
        await this.revealed();
        if (this.disposed) return;
      } else {
        run.shown = revealAll(run.state.segments);
        this.publish();
      }
    }
    await this.settle();
  }

  /**
   * Re-attaching failed `MAX_RESUMES` times in a row. Ask once more before
   * letting the run go: one that still runs (or no answer — offline) keeps its
   * busy mark (`alive`); another run in the slot is looked for once this reader
   * has settled; otherwise it is over.
   */
  private async lastLook(reader: Reader): Promise<ReadOutcome> {
    const probe = await this.deps.api.getChatRun(this.sessionId);
    if (reader.detached || this.disposed) return 'detached';
    if (!probe) return 'alive';
    const current = probe.active ? (probe.run?.run_id ?? null) : null;
    if (current === null) return 'ended';
    const owned = this.ownedElsewhere(reader, current);
    // Its own run (one never identified is taken to be the run in the slot, unless a waiting reader owns that).
    if (current === reader.runId || (reader.runId === null && !owned)) {
      if (reader.runId === null) {
        reader.runId = current;
        if (this.run && !this.run.runId) this.run.runId = current;
      }
      this.noteOwnRunning(current);
      return 'alive';
    }
    // Another run took the slot: a waiting reader reads it, or it is looked for once this one has settled.
    if (!owned) this.recheck = true;
    return 'ended';
  }

  /** Feed one source to the run until it ends (returns) or the transport fails / is cut (throws). */
  private async read(reader: Reader, source: AsyncIterable<RunStreamEvent>): Promise<void> {
    const it = source[Symbol.asyncIterator]();
    const signal = reader.transport.signal;
    try {
      for (;;) {
        const step = await nextOrAbort(it, signal);
        if (step.done) return;
        if (reader.detached) throw ABORTED;
        reader.lastEventAt = this.deps.clock.now();
        reader.events += 1;
        this.apply(step.value);
      }
    } finally {
      if (signal.aborted) void it.return?.(undefined)?.catch(() => {});
    }
  }

  /**
   * A reader starts on a run: fresh live state. `again` = the same run read
   * once more from its start (its id was never learned): sends stay where they
   * were placed. Otherwise every send made before this run sits before its
   * first turn, and what the run persisted before this reader arrived (the
   * member's message, earlier turns) is re-read unless the caller just did.
   */
  private beginRun(reader: Reader, o: { reload: boolean; again?: boolean }): void {
    const key = `${this.sessionId}:${reader.runId ?? this.deps.clock.now()}`;
    this.run = {
      key,
      runId: reader.runId,
      state: emptyRunState(),
      shown: [],
      byMe: reader.byMe,
      replaying: false,
      matched: 0,
    };
    this.presentCache = [];
    this.stopRemoteBusy();
    this.softRemote = false;
    if (!o.again && this.pending.some((send) => send.afterSegment !== 0)) {
      this.pending = this.pending.map((send) => (send.afterSegment === 0 ? send : { ...send, afterSegment: 0 }));
    }
    if (reader.runId) this.noteOwnRunning(reader.runId);
    this.emit({ type: 'run-started', runKey: key, byMe: reader.byMe });
    this.publish();
    if (o.reload) void this.reloadLatest();
  }

  /**
   * Resuming found another run in the slot than the one being read — or this
   * reader never learned its run's id. Either way the run is read again from
   * its start (a new run's seq starts at 0): the persisted rows come in first,
   * so nothing on screen flickers away, then the replay is instant (no
   * haptics, no announcements). A run never identified may be the same one:
   * its already-matched interjection turns stay matched.
   */
  private async switchRun(reader: Reader, runId: string): Promise<void> {
    const run = this.run;
    const unknown = reader.runId === null;
    await this.reloadLatest({ quiet: true });
    if (reader.detached || this.disposed) return;
    if (run) {
      this.clearRunning(run.runId);
      this.emit({ type: 'run-settled', runKey: run.key });
    }
    reader.runId = runId;
    reader.byMe = reader.byMe && unknown;
    this.beginRun(reader, { reload: false, again: unknown });
    if (unknown && run && this.run) this.run.matched = run.matched;
  }

  /** The run is over: the persisted rows replace the live ones in one commit. */
  private async settle(): Promise<void> {
    const run = this.run;
    const reloaded = await this.reloadLatest({ quiet: true });
    if (this.disposed) return;
    if (this.run === run && run) {
      if (reloaded === 'ok') this.run = null;
      // No reload: keep the finished run on screen; the next good reload drops it.
      else run.shown = revealAll(run.state.segments);
    }
    this.hardStopping = false;
    this.softRemote = false;
    if (reloaded === 'ok') this.reviewUnconfirmed(true);
    if (run) this.emit({ type: 'run-settled', runKey: run.key });
    this.publish();
    this.markRead();
  }

  private apply(event: RunStreamEvent): void {
    const run = this.run;
    if (!run || event.type === 'ping') return;
    const replayed = event.replayed === true;
    const before = run.state;
    run.state = applyRunEvent(before, event);
    run.replaying = replayed;
    switch (event.type) {
      case 'text-delta':
      case 'reasoning-delta':
      case 'tool-call-start':
      case 'tool-call-delta':
      case 'tool-call':
      case 'tool-result':
        // Replayed text is shown at once; live text is typed out. The tick publishes.
        if (replayed && run.state.current >= 0)
          run.shown = revealSegment(run.state.segments, run.shown, run.state.current);
        this.ensureReveal();
        return;
      case 'bot-turn-start':
        this.emit({ type: 'segment-start', botId: event.bot_id, replayed });
        if (event.reason === 'interjection') this.pickUp(run);
        break;
      case 'bot-request':
        this.emit({ type: 'request-arrived', request: event.request, replayed });
        break;
      case 'finish':
        this.clearRunning(run.runId);
        break;
      default:
        if (run.state === before) return;
    }
    this.publish();
  }

  /** A new interjection turn answers the oldest queued send made before it — each turn once. */
  private pickUp(run: LiveRun): void {
    const turns = run.state.interjections;
    if (turns.length <= run.matched) return;
    const fresh = turns.slice(run.matched);
    run.matched = turns.length;
    this.pending = pickUpQueued(this.pending, fresh);
  }

  // ─── Busy bookkeeping (the store's `running`) ────────────

  /** The store's busy mark for this thread (null: none). */
  private mark(): string | null {
    return this.deps.store.getState().running[this.sessionId] ?? null;
  }

  /** This device reads `runId`: busy for the drawer too (the socket may be down). Never overrides another id. */
  private noteOwnRunning(runId: string): void {
    const store = this.deps.store.getState();
    if (store.running[this.sessionId] === undefined) store.setRunning(this.sessionId, runId);
  }

  /** Clear the busy mark — only when it is `runId`'s (null: whatever it is). */
  private clearRunning(runId: string | null): void {
    const store = this.deps.store.getState();
    const current = store.running[this.sessionId];
    if (current === undefined) return;
    if (runId === null || current === runId) store.setRunning(this.sessionId, null);
  }

  // ─── Typing out ─────────────────────────────────────────

  private ensureReveal(): void {
    if (this.revealTimer !== null || this.disposed) return;
    this.revealTimer = this.deps.clock.setTimeout(() => this.revealTick(), TICK_MS);
  }

  private revealTick(): void {
    this.revealTimer = null;
    const run = this.run;
    if (this.disposed || !run) {
      this.resolveRevealWaiters();
      return;
    }
    const next = revealStep(run.state.segments, run.shown, run.state.finished);
    if (next) run.shown = next;
    // At most one snapshot per tick, carrying every stream event since the last.
    this.flush();
    if (revealFront(run.state.segments, run.shown) >= 0) this.ensureReveal();
    else this.resolveRevealWaiters();
  }

  /** Resolves once everything the run produced is on screen. */
  private revealed(): Promise<void> {
    const run = this.run;
    if (!run || this.disposed || revealFront(run.state.segments, run.shown) < 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.revealWaiters.push(resolve);
      this.ensureReveal();
    });
  }

  private resolveRevealWaiters(): void {
    for (const resolve of this.revealWaiters.splice(0)) resolve();
  }

  // ─── Pushes & polling ───────────────────────────────────

  private onRealtime(e: RealtimeEvent): void {
    if (this.disposed) return;
    switch (e.type) {
      case 'chat:run':
        if (e.sessionId !== this.sessionId) return;
        if (e.status === 'running') {
          // Announced before the POST that started it answers: that POST's stream will read it.
          if (this.sendsInFlight > 0) {
            this.latchRunId = e.runId;
            return;
          }
          if (this.readsRun(e.runId)) return;
          this.attachForPush(e.runId);
          return;
        }
        if (this.latchRunId === e.runId) this.latchRunId = null;
        // Ended with nobody here reading it: what it wrote is in the transcript now.
        if (!this.busyReading()) void this.reload();
        return;
      case 'bots:conversation':
        if (e.sessionId !== this.sessionId) return;
        this.clearTimer(this.conversationTimer);
        this.conversationTimer = this.deps.clock.setTimeout(() => {
          this.conversationTimer = null;
          void this.reload();
        }, CONVERSATION_RELOAD_MS);
        return;
      case 'resync':
        // (Re)connected: pushes may have been missed.
        void this.ensureAttached();
        void this.reload();
        return;
      default:
        return;
    }
  }

  private onStore(): void {
    const state = this.deps.store.getState();
    const running = state.running[this.sessionId] ?? null;
    if (running === this.seenRunning && state.requestOverrides === this.seenOverrides) return;
    // A card of this thread settled in a sheet (needs-you, sign-in, the Bot form decide through the store).
    if (state.requestOverrides !== this.seenOverrides && this.settledHere(state.requestOverrides)) {
      this.probeAfterDecision();
    }
    this.seenRunning = running;
    this.seenOverrides = state.requestOverrides;
    // The run nobody here was reading has ended: a soft stop asked for it is over too.
    if (running === null && !this.busyReading() && !this.remoteBusy) this.softRemote = false;
    this.publish();
  }

  /** A new override settles one of this thread's cards. */
  private settledHere(overrides: Record<string, BotRequestView>): boolean {
    const seen = this.seenOverrides;
    for (const id in overrides) {
      const request = overrides[id];
      if (request !== seen[id] && request.session_id === this.sessionId && request.status !== 'pending') return true;
    }
    return false;
  }

  /** After a card decision — here or in a sheet — look once for the run it may have started. */
  private probeAfterDecision(): void {
    if (this.decideProbe) return;
    this.decideProbe = true;
    this.after(DECIDE_PROBE_MS, () => {
      this.decideProbe = false;
      void this.ensureAttached();
    });
  }

  /** Socket down for a while, thread visible: probe every beat, reload every 3rd. */
  private pollBeat(n: number): void {
    if (this.disposed) return;
    const markBefore = this.mark();
    void this.deps.api.getChatRun(this.sessionId).then((probe) => {
      if (this.disposed || !probe) return;
      if (probe.active && probe.run && !this.readsRun(probe.run.run_id)) void this.ensureAttached(probe);
      else if (!probe.active && !this.noteIdle(markBefore, probe.run?.run_id ?? null)) void this.ensureAttached();
    });
    if (n % POLL_RELOAD_EVERY === 0) {
      void this.reloadLatest().then((result) => {
        if (result === 'ok') this.markRead();
      });
    }
  }

  // ─── Snapshot & effects ─────────────────────────────────

  private compose(): ThreadSnapshot {
    const state = this.deps.store.getState();
    const reading = (this.reader !== null && !this.run?.state.finished) || this.waiting.length > 0;
    const runActive = reading || this.remoteBusy !== null || state.running[this.sessionId] !== undefined;
    const soft = this.softAsked > 0 || this.softRemote || this.run?.state.interrupting === true;
    return {
      sessionId: this.sessionId,
      load: this.load,
      refreshFailed: this.refreshFailed,
      conversation: this.conversation,
      messages: this.messages,
      hasMore: this.hasMore,
      earlier: this.earlier,
      memoryStates: this.memoryStates,
      run: this.presentRun(),
      runActive,
      remoteBusy: this.remoteBusy !== null,
      stopPhase: !runActive ? null : this.hardStopping ? 'hard' : soft ? 'soft' : null,
      pending: this.pending,
      requests: this.mergedRequests(state.requestOverrides),
      runError: this.runError,
      readOnly: this.readOnly,
    };
  }

  private presentRun(): ThreadRun | null {
    const run = this.run;
    if (!run) return null;
    const memo = this.runMemo;
    if (
      memo &&
      memo.run === run &&
      memo.runId === run.runId &&
      memo.state === run.state &&
      memo.shown === run.shown &&
      memo.replaying === run.replaying
    ) {
      return memo.out;
    }
    const out: ThreadRun = {
      key: run.key,
      runId: run.runId,
      segments: presentSegments(run.state.segments, run.shown, this.presentCache),
      revealing: revealFront(run.state.segments, run.shown),
      requests: run.state.requests,
      interrupting: run.state.interrupting,
      replaying: run.replaying,
    };
    this.runMemo = { run, runId: run.runId, state: run.state, shown: run.shown, replaying: run.replaying, out };
    return out;
  }

  private mergedRequests(overrides: Record<string, BotRequestView>): ReadonlyMap<string, BotRequestView> {
    const rest = this.conversation?.requests;
    const live = this.run?.state.requests;
    const memo = this.requestsMemo;
    if (memo && memo.rest === rest && memo.live === live && memo.overrides === overrides) return memo.out;
    const out = mergeRequests({ rest: rest ?? [], live: live ?? [], overrides });
    this.requestsMemo = { rest, live, overrides, out };
    return out;
  }

  /** Publish on the next microtask (several changes in one turn → one snapshot). */
  private publish(): void {
    if (this.publishQueued || this.disposed) return;
    this.publishQueued = true;
    void Promise.resolve().then(() => {
      this.publishQueued = false;
      this.flush();
    });
  }

  private flush(): void {
    if (this.disposed) return;
    const next = this.compose();
    if (shallowEqual(next, this.snap)) return;
    this.snap = next;
    for (const listener of [...this.listeners]) listener();
  }

  private emit(effect: ThreadEffect): void {
    for (const listener of [...this.effectListeners]) {
      try {
        listener(effect);
      } catch {
        /* a screen's failure must not stop the run */
      }
    }
  }

  // ─── Timers ─────────────────────────────────────────────

  private after(ms: number, fn: () => void): void {
    const handle = this.deps.clock.setTimeout(() => {
      this.timers.delete(handle);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(handle);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.after(ms, resolve));
  }

  private clearTimer(handle: unknown): void {
    if (handle !== null) this.deps.clock.clearTimeout(handle);
  }
}
