/**
 * Chat Run Registry — in-process registry of in-flight chat generations.
 *
 * A "run" is one assistant turn: the agent loop pumps stream events into the
 * run's seq-numbered buffer, and any number of HTTP responses subscribe to it
 * (the original POST /api/chat response is just subscriber #1). Because the
 * loop's lifetime is owned by the run — not by an HTTP response — a client
 * refresh/disconnect no longer orphans the generation: the browser re-attaches
 * via GET /api/chat/runs/:sessionId/stream and replays from any seq.
 *
 * Deliberately in-memory: the api deploys as a single pm2 fork process, and a
 * run's terminal persistence (assistant message) is still the DB's job — the
 * registry only holds the transient wire events. Process death loses in-flight
 * runs exactly like before; graceful shutdown aborts them first so the
 * interruption-persistence path can write safe partials (see shutdown()).
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@greenhouse/utils/logger';
import type { ChatRunStatus, RunReplayEnvelope } from '@greenhouse/types/api';

export type { ChatRunStatus };
export type ChatRunStopReason = 'user' | 'shutdown' | 'account-security';

/**
 * A buffered wire event: an NDJSON payload plus the replay envelope the browser
 * reads back (`@greenhouse/types/api` owns those two field names so the stamping
 * side and the consuming side can't drift). `seq` is always present here —
 * it's assigned on emit — while the shared envelope keeps it optional because
 * a live-only consumer may never see one.
 */
export type ChatRunEvent = Record<string, unknown> & { type: string } & RunReplayEnvelope & { seq: number };

export interface ChatRunSubscriber {
  onEvent: (event: ChatRunEvent) => void;
  /** Fired once, after the run has ended AND its persistence completed. */
  onEnd: (status: ChatRunStatus) => void;
}

/**
 * Hard cap on the replay buffer. A 15-minute turn's wire volume is bounded by
 * model output + tool result summaries (typically well under 1 MB); the cap is
 * a backstop against pathological tool outputs. On overflow the oldest events
 * are dropped — live subscribers are unaffected, and a late reconnect replays
 * a truncated prefix that the post-run message reload corrects anyway.
 */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** How long an ended run stays addressable so just-too-late reconnects still replay. */
const RUN_RETENTION_MS = 60_000;

export class ChatRun {
  readonly runId = randomUUID();
  readonly startedAt = Date.now();
  status: ChatRunStatus = 'running';
  stopReason?: ChatRunStopReason;

  private events: ChatRunEvent[] = [];
  private bufferBytes = 0;
  private seqCounter = 0;
  private overflowed = false;
  private subscribers = new Set<ChatRunSubscriber>();
  private readonly abortController = new AbortController();
  private endedResolve!: () => void;
  /** Resolves when the run has ended (after persistence). */
  readonly ended = new Promise<void>((r) => {
    this.endedResolve = r;
  });

  constructor(
    readonly sessionId: string | null,
    readonly userId: string,
  ) {}

  /** Abort signal for the underlying streamText loop. */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** Next seq an emit would get — lets a probe report how far the run has streamed. */
  get nextSeq(): number {
    return this.seqCounter;
  }

  /** Append an event to the buffer and fan it out to live subscribers. */
  emit(event: Record<string, unknown>): void {
    if (this.status !== 'running') return;
    const evt = { ...event, seq: this.seqCounter++ } as ChatRunEvent;

    const size = JSON.stringify(evt).length;
    this.events.push(evt);
    this.bufferBytes += size;
    while (this.bufferBytes > MAX_BUFFER_BYTES && this.events.length > 1) {
      const dropped = this.events.shift()!;
      this.bufferBytes -= JSON.stringify(dropped).length;
      if (!this.overflowed) {
        this.overflowed = true;
        logger.warn('[chat-runs] replay buffer overflow — dropping oldest events', {
          sessionId: this.sessionId,
          runId: this.runId,
        });
      }
    }

    for (const sub of [...this.subscribers]) {
      try {
        sub.onEvent(evt);
      } catch {
        /* a broken subscriber must not break the run */
      }
    }
  }

  /**
   * Replay buffered events with seq > afterSeq, then follow live until the run
   * ends. Replayed events are tagged `replayed: true` so clients can skip
   * side-effectful ones (e.g. re-executing a client action on refresh).
   * Synchronous replay + single-threaded emit ⇒ no gaps, no duplicates.
   * Returns an unsubscribe function.
   */
  subscribe(afterSeq: number, sub: ChatRunSubscriber): () => void {
    for (const evt of this.events) {
      if (evt.seq > afterSeq) sub.onEvent({ ...evt, replayed: true });
    }
    if (this.status !== 'running') {
      sub.onEnd(this.status);
      return () => {};
    }
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  /** Request the run to stop; the agent loop winds down via its abort signal. */
  requestStop(reason: ChatRunStopReason): void {
    if (this.status !== 'running') return;
    this.stopReason ??= reason;
    this.abortController.abort();
  }

  /**
   * Mark the run ended — call AFTER persistence, so a subscriber that sees its
   * stream close can immediately refetch messages without racing the DB write.
   *
   * Production code goes through `chatRunRegistry.finish()`, which also frees
   * the session slot and schedules eviction; calling this directly leaves the
   * run addressable forever. Kept public only so unit tests can drive a
   * standalone ChatRun.
   */
  end(status: Exclude<ChatRunStatus, 'running'>): void {
    if (this.status !== 'running') return;
    this.status = status;
    this.endedResolve();
    for (const sub of [...this.subscribers]) {
      try {
        sub.onEnd(status);
      } catch {
        /* ignore */
      }
    }
    this.subscribers.clear();
  }
}

class ChatRunRegistry {
  /** Session-addressable runs: the active one, or the last ended one during retention. */
  private bySession = new Map<string, ChatRun>();
  /** Every running run, including detached (stateless) ones — used by shutdown(). */
  private live = new Set<ChatRun>();

  /**
   * Atomically claim the single run slot for a session. Returns null when a
   * generation is already running — the route turns that into a 409 (which
   * also prevents a duplicate POST from double-appending the user message).
   */
  claim(sessionId: string, userId: string): ChatRun | null {
    const existing = this.bySession.get(sessionId);
    if (existing && existing.status === 'running') return null;
    const run = new ChatRun(sessionId, userId);
    this.bySession.set(sessionId, run);
    this.live.add(run);
    return run;
  }

  /** A run that streams to the response only (stateless mode) — not reconnectable. */
  createDetached(userId: string): ChatRun {
    const run = new ChatRun(null, userId);
    this.live.add(run);
    return run;
  }

  /**
   * Release a claimed run that never started pumping (a pre-stream validation
   * failed). Silent — no WS event was sent, no subscriber ever existed.
   */
  release(run: ChatRun): void {
    this.live.delete(run);
    if (run.sessionId && this.bySession.get(run.sessionId) === run) {
      this.bySession.delete(run.sessionId);
    }
  }

  /** End a run (call after persistence) and schedule its eviction. */
  finish(run: ChatRun, status: Exclude<ChatRunStatus, 'running'>): void {
    run.end(status);
    this.live.delete(run);
    if (!run.sessionId) return;
    const timer = setTimeout(() => {
      if (this.bySession.get(run.sessionId!) === run) this.bySession.delete(run.sessionId!);
    }, RUN_RETENTION_MS);
    timer.unref?.();
  }

  /** The active or retained run for a session (undefined once evicted). */
  get(sessionId: string): ChatRun | undefined {
    return this.bySession.get(sessionId);
  }

  /** The run for a session only while it is still generating. */
  getActive(sessionId: string): ChatRun | undefined {
    const run = this.bySession.get(sessionId);
    return run && run.status === 'running' ? run : undefined;
  }

  /** All in-flight session runs owned by a user (for the sidebar/attach seed). */
  listActiveForUser(userId: string): ChatRun[] {
    return [...this.live].filter((r) => r.userId === userId && r.sessionId !== null && r.status === 'running');
  }

  /** Abort every stateful or detached run owned by a credential-suspended user. */
  stopForUser(userId: string): number {
    const active = [...this.live].filter((run) => run.userId === userId && run.status === 'running');
    for (const run of active) run.requestStop('account-security');
    return active.length;
  }

  /**
   * Graceful-shutdown hook: abort every in-flight run and wait (bounded) for
   * their interruption persistence, so a deploy doesn't lose whole answers.
   */
  async shutdown(timeoutMs = 5000): Promise<void> {
    const active = [...this.live].filter((r) => r.status === 'running');
    if (active.length === 0) return;
    logger.info(`[chat-runs] aborting ${active.length} in-flight run(s) for shutdown`);
    for (const run of active) run.requestStop('shutdown');
    await Promise.race([Promise.all(active.map((r) => r.ended)), new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  }
}

/** Singleton — one registry per api process. */
export const chatRunRegistry = new ChatRunRegistry();
