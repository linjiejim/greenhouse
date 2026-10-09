/**
 * The Bots feature's internal contract — the shapes the thread engine, the
 * realtime client, the store and the screens agree on (spec
 * docs/specs/20261008-mobile-bots.md §8 P0, frozen once P0 landed). Types only:
 * the implementations live next to their owners (engine: thread/engine.ts,
 * realtime: src/api/ws.ts, store: ./store.ts, cards: cards/*).
 */

import type {
  BotConversationDetail,
  BotMessage,
  BotRequestDecision,
  BotRequestErrorCode,
  BotRequestView,
} from '../shared/bots';
import type { BotStreamSegment } from '../shared/bots-wire';
import type { BotsState } from './store';
import type { PendingWithBase } from './vendor/web-helpers';

// ─── Realtime (WS /api/ws) ───────────────────────────────

/**
 * The subset of the server's WS frames (packages/types/src/ws.ts
 * `ServerWsEvent`) mobile reads — guarded member by member in
 * vendor/vendor.parity.test.ts. src/api/ws.ts parses it and maps it to
 * `RealtimeEvent`; every other frame is dropped.
 */
export type ServerWsWire =
  | { type: 'connected'; userId: string }
  | { type: 'ping' }
  | { type: 'chat:run'; sessionId: string; runId: string; status: 'running' | 'completed' | 'error' }
  | { type: 'bots:conversation'; sessionId: string }
  | { type: 'bots:attention'; pending: number };

export type RealtimeEvent =
  | { type: 'chat:run'; sessionId: string; runId: string; status: 'running' | 'completed' | 'error' }
  | { type: 'bots:conversation'; sessionId: string }
  | { type: 'bots:attention'; pending: number }
  /** Synthesised: the socket (re)connected or the app came back to the foreground — re-read everything. */
  | { type: 'resync' };

export type RealtimeStatus = 'off' | 'connecting' | 'open' | 'backoff' | 'cooling' | 'stopped';

export interface Realtime {
  readonly status: RealtimeStatus;
  on(handler: (e: RealtimeEvent) => void): () => void;
  onStatus(listener: (s: RealtimeStatus) => void): () => void;
  /** When the socket last left `open` (ms), null while open. */
  downSince(): number | null;
}

// ─── Decisions & sends ───────────────────────────────────

export type DecideOutcome =
  | { kind: 'ok'; request: BotRequestView }
  /** 409 `already_decided` / `deciding` / no code: settled elsewhere — re-read quietly. */
  | { kind: 'stale' }
  /** Not carried out (or no answer: status 0); the card stays pending. */
  | { kind: 'refused'; status: number; code: BotRequestErrorCode | null; message: string };

export interface SendInput {
  text: string;
  images: Array<{ id: string; url: string }>;
  mentions: string[];
}

export type SendOutcome =
  | { ok: true; startedRun: boolean }
  /** Nobody here can reply (409): the thread turns read-only. */
  | { ok: false; kind: 'read_only'; code: 'bot_archived' | 'no_active_members' }
  /** Refused by the server: the bubble is removed, the draft restored, an alert shown. */
  | { ok: false; kind: 'rejected'; status: number; message: string }
  /** No answer: the bubble stays, marked "Not Delivered", with Try Again. */
  | { ok: false; kind: 'not_delivered' };

/** A send in flight on this device; `failed` = the POST got no answer (kept for a retry). */
export interface MobilePending extends PendingWithBase {
  failed?: boolean;
}

// ─── Thread engine ───────────────────────────────────────

/** The live run the thread is reading (or replaying). */
export interface ThreadRun {
  /** `${sessionId}:${runId ?? localStartMs}`. */
  key: string;
  runId: string | null;
  /** Text cut at the reveal front; structurally shared — only changed segments are new objects. */
  segments: BotStreamSegment[];
  /** Index of the segment being typed out, -1 = none. */
  revealing: number;
  /** Cards raised during this run (latest copy per id). */
  requests: BotRequestView[];
  interrupting: boolean;
  replaying: boolean;
}

export interface ThreadSnapshot {
  sessionId: string;
  load: 'loading' | 'ready' | 'not_found' | 'forbidden' | 'error';
  /** A refresh failed after a good load; the transcript stays on screen. */
  refreshFailed: boolean;
  conversation: BotConversationDetail | null;
  /** Every loaded page merged, `seq` ascending. */
  messages: BotMessage[];
  hasMore: boolean;
  earlier: 'idle' | 'loading' | 'error';
  memoryStates: Record<string, string>;
  run: ThreadRun | null;
  /** A local reader || `remoteBusy` || `useBots.running[sessionId]`. */
  runActive: boolean;
  /** The server is busy but this device cannot attach (another API slot): a static "Working…". */
  remoteBusy: boolean;
  stopPhase: 'soft' | 'hard' | null;
  pending: MobilePending[];
  /** Merged from three sources, only ever forward (`mergeRequests`). */
  requests: ReadonlyMap<string, BotRequestView>;
  runError: string | null;
  readOnly: 'bot_archived' | 'no_active_members' | null;
}

export type ThreadEffect =
  | { type: 'segment-start'; botId: string; replayed: boolean }
  | { type: 'request-arrived'; request: BotRequestView; replayed: boolean }
  | { type: 'run-started'; runKey: string; byMe: boolean }
  | { type: 'run-settled'; runKey: string };

export interface ThreadController {
  getSnapshot(): ThreadSnapshot;
  subscribe(listener: () => void): () => void;
  onEffect(listener: (e: ThreadEffect) => void): () => void;
  /** Focused && foreground (a sheet on top does not count). Drives read receipts and polling. */
  setVisible(visible: boolean): void;
  setForeground(active: boolean): void;
  send(input: SendInput): Promise<SendOutcome>;
  retry(clientId: string): Promise<SendOutcome>;
  /** Drop a local bubble only. */
  discard(clientId: string): void;
  /** 'next' = a tap: soft, or hard when already soft. */
  stop(mode?: 'next' | 'soft' | 'hard'): void;
  handleNow(clientId: string): Promise<'ok' | 'refused'>;
  decide(request: BotRequestView, body: BotRequestDecision): Promise<DecideOutcome>;
  loadEarlier(): Promise<void>;
  reload(): Promise<void>;
  dismissRunError(): void;
}

export interface ThreadDeps {
  api: Pick<typeof import('../api/bots'), 'getConversation' | 'markConversationRead'> &
    Pick<
      typeof import('../api/chat'),
      'openBotsChat' | 'interruptChatRun' | 'getChatRun' | 'streamChatRun' | 'stopChatRun'
    >;
  realtime: Realtime;
  store: { getState(): BotsState; subscribe(listener: (s: BotsState) => void): () => void };
  clock: { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
}

// ─── Card props ──────────────────────────────────────────

export interface RequestCardProps {
  request: BotRequestView;
  sessionId: string;
  readOnly: boolean;
  highlighted?: boolean;
  /** Thread → `ctl.decide`; needs-you sheet → `useBots.decide`. */
  onDecide(body: BotRequestDecision): Promise<DecideOutcome>;
  /** Sends `@Name Please try that again.` with `mentions`; not passed in the needs-you sheet. */
  onAskAgain?: (botId: string) => void;
}
