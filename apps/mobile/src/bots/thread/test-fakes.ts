/**
 * Fakes for the Bots engine and realtime tests (root vitest): a virtual clock,
 * a realtime source the test drives, a controllable NDJSON stream, a scripted
 * thread API, and a real Bots store (./store-core.ts) over in-memory set/get.
 *
 * Plain TypeScript, no vitest import: the app's own type check includes this
 * file (it is not a *.test.ts), and nothing here may load React Native.
 */

import type { BotsPost, ChatRunProbe, RunStreamEvent } from '../../api/chat';
import type { BotConversationDetail, BotMessage, BotRequestView, BotView } from '../../shared/bots';
import type { BotsOverview, ConversationPage } from '../../shared/bots-wire';
import type { Realtime, RealtimeEvent, RealtimeStatus, ThreadDeps } from '../contract';
import { createBotsSlice, type BotsState, type BotsStoreDeps, type SetBots } from '../store-core';

// ─── Async helpers ───────────────────────────────────────

/** Let every pending promise chain run (a macrotask turn, twice). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ─── Clock ───────────────────────────────────────────────

interface Timer {
  at: number;
  id: number;
  fn: () => void;
  live: boolean;
}

/** Virtual time: timers run only in `advance`, in time order, with promise chains settled between. */
export class FakeClock {
  t = 1_000_000;
  private timers: Timer[] = [];
  private seq = 0;

  readonly clock: ThreadDeps['clock'] = {
    now: () => this.t,
    setTimeout: (fn, ms) => {
      const timer: Timer = { at: this.t + Math.max(0, ms), id: this.seq++, fn, live: true };
      this.timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      if (handle && typeof handle === 'object') (handle as Timer).live = false;
    },
  };

  /** Move time forward by `ms`, running every timer due on the way. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    await settle();
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.live && timer.at <= end)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      due.live = false;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
      await settle();
    }
    this.t = end;
    await settle();
  }

  /** Live timers, soonest first (for asserting nothing is scheduled). */
  pending(): number[] {
    return this.timers.filter((timer) => timer.live).map((timer) => timer.at - this.t);
  }
}

// ─── Realtime ────────────────────────────────────────────

export class FakeRealtime implements Realtime {
  status: RealtimeStatus;
  private down: number | null;
  private handlers = new Set<(e: RealtimeEvent) => void>();
  private listeners = new Set<(s: RealtimeStatus) => void>();
  private readonly now: () => number;

  constructor(now: () => number, status: RealtimeStatus = 'open') {
    this.now = now;
    this.status = status;
    this.down = status === 'open' ? null : now();
  }

  on(handler: (e: RealtimeEvent) => void) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onStatus(listener: (s: RealtimeStatus) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  downSince() {
    return this.status === 'open' ? null : this.down;
  }

  emit(event: RealtimeEvent): void {
    for (const handler of [...this.handlers]) handler(event);
  }

  setStatus(status: RealtimeStatus): void {
    if (status === this.status) return;
    if (this.status === 'open') this.down = this.now();
    this.status = status;
    for (const listener of [...this.listeners]) listener(status);
  }
}

// ─── Streams ─────────────────────────────────────────────

/** An NDJSON stream the test feeds event by event; `fail` drops the transport, `end` closes it. */
export class FakeStream {
  private queue: RunStreamEvent[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  private error: unknown = null;
  /** The reader asked for its first event. */
  opened = false;
  /** The reader let go (`return()`), or the stream was cut. */
  closed = false;
  readonly events: AsyncGenerator<RunStreamEvent>;

  constructor(initial: RunStreamEvent[] = []) {
    this.queue.push(...initial);
    this.events = this.generate();
  }

  private async *generate(): AsyncGenerator<RunStreamEvent> {
    this.opened = true;
    try {
      for (;;) {
        if (this.queue.length > 0) {
          yield this.queue.shift() as RunStreamEvent;
          continue;
        }
        if (this.error) throw this.error;
        if (this.ended) return;
        await new Promise<void>((resolve) => (this.wake = resolve));
      }
    } finally {
      this.closed = true;
    }
  }

  push(...events: RunStreamEvent[]): this {
    this.queue.push(...events);
    this.poke();
    return this;
  }

  end(): this {
    this.ended = true;
    this.poke();
    return this;
  }

  /** The transport dies (network); `status` makes it an HTTP failure (e.g. 404 on re-attach). */
  fail(status?: number): this {
    this.error = Object.assign(new Error('network'), status ? { status } : {});
    this.poke();
    return this;
  }

  private poke() {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

// ─── Fixtures ────────────────────────────────────────────

export function bot(id: string, partial: Partial<BotView> = {}): BotView {
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

export function conversation(sessionId: string, partial: Partial<BotConversationDetail> = {}): BotConversationDetail {
  return {
    session_id: sessionId,
    kind: 'direct',
    title: null,
    owner_bot_id: 'bot_a',
    lead_bot_id: 'bot_a',
    members: [{ bot_id: 'bot_a', role: 'owner', position: 0 }],
    last_message: null,
    attention: 'idle',
    pending_requests: 0,
    last_activity_at: '2026-10-08T00:00:00.000Z',
    description: '',
    allow_bot_chat: true,
    digest: null,
    notes: [],
    requests: [],
    context: { estimated_tokens: 0, threshold: 1 },
    ...partial,
  };
}

export function message(seq: number, partial: Partial<BotMessage> = {}): BotMessage {
  return {
    id: `m${seq}`,
    role: 'assistant',
    content: `message ${seq}`,
    bot_id: 'bot_a',
    bot_event: null,
    pipeline: [],
    references: [],
    reasoning: null,
    model: null,
    images: [],
    created_at: '2026-10-08T00:00:00.000Z',
    seq,
    ...partial,
  };
}

export function request(id: string, partial: Partial<BotRequestView> = {}): BotRequestView {
  return {
    id,
    session_id: 's1',
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

export function page(
  sessionId: string,
  messages: BotMessage[],
  partial: Partial<ConversationPage> = {},
): ConversationPage {
  return { conversation: conversation(sessionId), messages, has_more: false, ...partial };
}

// ─── Thread API ──────────────────────────────────────────

type ThreadApi = ThreadDeps['api'];
type Read<T> = { ok: true; value: T } | { ok: false; status: number; code: string | null };

/**
 * A scripted thread API. Each call is recorded; answers come from the
 * overridable handlers (defaults: the server's newest page = `server.messages`,
 * no run, interrupts accepted, stops accepted, the next queued POST answer).
 */
export class FakeThreadApi {
  /** What `GET /conversations/:id` returns (newest page = the last `PAGE_SIZE`). */
  server: { conversation: BotConversationDetail; messages: BotMessage[]; hasMore: boolean };
  probe: ChatRunProbe | null = { active: false };
  /** One-off probe answers, consumed in order before `probe` (a deferred holds that one probe open). */
  probes: Array<ChatRunProbe | null | Promise<ChatRunProbe | null>> = [];
  /** POST answers, consumed in order (a deferred lets the test hold the POST open). */
  posts: Array<BotsPost | Promise<BotsPost>> = [];
  /** `streamChatRun` answers, consumed in order (default: a stream that fails with 404). */
  attaches: FakeStream[] = [];
  interrupt: Array<'interrupting' | 'no_run' | 'refused' | Promise<'interrupting' | 'no_run' | 'refused'>> = [];
  stopOk = true;
  conversationFailure: number | null = null;
  readOk = true;
  /** While set, `getConversation` / `getChatRun` wait for it (hold a reload or a probe open). */
  conversationGate: Promise<void> | null = null;
  probeGate: Promise<void> | null = null;

  calls = {
    getConversation: [] as Array<{ beforeSeq?: number; limit?: number }>,
    markRead: 0,
    open: [] as Array<{ content: string; images?: unknown[]; mentions?: string[] }>,
    interrupt: 0,
    probe: 0,
    attach: [] as number[],
    stop: 0,
  };

  constructor(sessionId: string) {
    this.server = { conversation: conversation(sessionId), messages: [], hasMore: false };
  }

  readonly api: ThreadApi = {
    getConversation: async (_sessionId, opts) => {
      this.calls.getConversation.push({ ...opts });
      await (this.conversationGate ?? Promise.resolve());
      if (this.conversationFailure !== null) {
        return { ok: false, status: this.conversationFailure, code: null } as Read<ConversationPage>;
      }
      const all = this.server.messages;
      const below = opts?.beforeSeq !== undefined ? all.filter((m) => m.seq < (opts.beforeSeq as number)) : all;
      const limit = opts?.limit ?? 60;
      const messages = below.slice(-limit);
      return {
        ok: true,
        value: {
          conversation: this.server.conversation,
          messages,
          has_more: below.length > messages.length || (opts?.beforeSeq === undefined && this.server.hasMore),
        },
      } as Read<ConversationPage>;
    },
    markConversationRead: async () => {
      this.calls.markRead += 1;
      return this.readOk;
    },
    openBotsChat: async (args) => {
      this.calls.open.push({ content: args.content, images: args.images, mentions: args.mentions });
      const next = this.posts.shift();
      if (!next) return { kind: 'error', status: 0, code: null, message: '' };
      return next;
    },
    interruptChatRun: async () => {
      this.calls.interrupt += 1;
      return this.interrupt.shift() ?? 'interrupting';
    },
    getChatRun: async () => {
      this.calls.probe += 1;
      const scripted = this.probes.shift();
      if (scripted !== undefined) return scripted;
      await (this.probeGate ?? Promise.resolve());
      return this.probe;
    },
    streamChatRun: (_sessionId, after) => {
      this.calls.attach.push(after);
      const stream = this.attaches.shift() ?? new FakeStream().fail(404);
      return stream.events;
    },
    stopChatRun: async () => {
      this.calls.stop += 1;
      return this.stopOk;
    },
  };
}

// ─── Store ───────────────────────────────────────────────

/** The real Bots store over in-memory set/get, with a subscribe that reports (state, previous). */
export function makeStore(api: Partial<BotsStoreDeps['api']> = {}, clock?: ThreadDeps['clock']) {
  const listeners = new Set<(state: BotsState, previous: BotsState) => void>();
  const overview: BotsOverview = {
    bots: [bot('bot_a'), bot('bot_b')],
    archived_bots: [],
    computer: { state: 'disabled', reason: null, hardened: false },
    vault_available: false,
    pending_requests: 0,
  };
  const calls = { listBots: 0, listConversations: 0, listRequests: 0, listChatRuns: 0, decide: 0 };
  const deps: BotsStoreDeps = {
    api: {
      listBots: async () => {
        calls.listBots += 1;
        return { ok: true as const, value: overview };
      },
      bootstrapBots: async () => ({ ok: false as const, status: 500, code: null, message: '' }),
      listConversations: async () => {
        calls.listConversations += 1;
        return { ok: true as const, value: [] };
      },
      listRequests: async () => {
        calls.listRequests += 1;
        return { ok: true as const, value: [] };
      },
      decideRequest: async () => {
        calls.decide += 1;
        return { ok: false as const, status: 500, code: null, message: '' };
      },
      listChatRuns: async () => {
        calls.listChatRuns += 1;
        return [];
      },
      ...api,
    },
    clock: clock ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: () => {} },
  };
  let state: BotsState;
  const set: SetBots = (partial) => {
    const previous = state;
    state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) };
    for (const listener of [...listeners]) listener(state, previous);
  };
  const get = () => state;
  state = createBotsSlice(set, get, deps);
  state = {
    ...state,
    botsLoaded: true,
    bots: overview.bots,
    byId: Object.fromEntries(overview.bots.map((b) => [b.id, b])),
  };
  return {
    store: {
      getState: get,
      subscribe: (listener: (state: BotsState, previous: BotsState) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    set,
    calls,
  };
}
