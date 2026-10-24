/**
 * One open conversation with the assistant. React-free (./conversation.test.ts); the screen
 * (app/chat.tsx) renders `state` and calls the methods, the network arrives through
 * `ConversationDeps`.
 *
 * - It opens on the latest page of messages and pages older history in front on demand
 *   (./transcript.ts); a reload merges and never drops what is loaded.
 * - A sent message shows at once, its reply streams in, and both stay on screen until the saved
 *   transcript holds the reply. When that read fails, or the reply is not saved yet, the exchange
 *   stays with a retry (`unreconciled`) instead of being replaced by a shorter transcript.
 * - A send the station never answered (offline) says so (`notice: 'offline'`): the screen queues
 *   it (src/store/outbox.ts) instead of giving the words back.
 * - A reply still being written when the conversation opens (or comes back into view, or when a
 *   send is refused with 409 because one is running) is followed until it ends, then reconciled.
 * - Everything stops quietly once `stillCurrent` says the station or account changed.
 */

import type { ApiMiss, ApiResult } from '../api/client';
import { applyEvent, EMPTY_REPLY, type ChatEvent, type LiveReply } from './chat-stream';
import { exchangeStart, holdsNewReply, withLatest, withOlder, type ExchangeStart, type MessagePage, type Transcript, type TranscriptMessage } from './transcript';

export type StreamOutcome = { ok: true; finished: boolean } | ApiMiss;

/** A picture sent with a message (uploaded first, `POST /api/upload`). */
export interface SentImage {
  id: string;
  url: string;
}

export interface ConversationDeps<M extends TranscriptMessage = TranscriptMessage> {
  /** The session's title, or a miss (404 when it is gone or not mine). */
  title(): Promise<ApiResult<{ title: string | null }>>;
  latestPage(): Promise<ApiResult<MessagePage<M>>>;
  olderPage(before: number): Promise<ApiResult<MessagePage<M>>>;
  send(text: string, onEvent: (event: ChatEvent) => void, signal: AbortSignal, images?: readonly SentImage[]): Promise<StreamOutcome>;
  /** Whether a reply is being written now. */
  runActive(): Promise<ApiResult<{ active: boolean }>>;
  /** Attach to the reply being written (replayed from its start). */
  follow(onEvent: (event: ChatEvent) => void, signal: AbortSignal): Promise<StreamOutcome>;
  stillCurrent(): boolean;
  wait(ms: number): Promise<void>;
}

export interface ConversationState<M extends TranscriptMessage = TranscriptMessage> {
  transcript: Transcript<M> | null;
  title: string | null;
  missing: boolean;
  loadFailed: boolean;
  /** My message on its way, shown until the saved transcript holds its reply. */
  pending: string | null;
  /** The pictures sent with it. */
  pendingImages: readonly SentImage[];
  /** The reply as it streams in. */
  reply: LiveReply | null;
  /** Sending, or following a reply being written. */
  busy: boolean;
  /** The exchange on screen is not confirmed by the saved transcript yet; offer a retry. */
  unreconciled: boolean;
  /** Following the reply being written broke off (the reply may still be saved later). */
  streamFailed: boolean;
  loadingOlder: boolean;
}

/** What the composer should do after a send. */
export type SendResult =
  | { sent: true }
  | { sent: false; restore: string; notice: 'busy' | 'failed' | 'offline'; message: string; status: number };

/** The state before a conversation opens. */
export const CLOSED_CONVERSATION: ConversationState<never> = {
  transcript: null,
  title: null,
  missing: false,
  loadFailed: false,
  pending: null,
  pendingImages: [],
  reply: null,
  busy: false,
  unreconciled: false,
  streamFailed: false,
  loadingOlder: false,
};

/** The first loaded message: it changes when older history comes in at the top. */
export function headOf(state: ConversationState): string {
  const first = state.transcript?.messages[0];
  return first ? `${first.seq}:${first.id}` : '';
}

/**
 * What is at the bottom of the conversation. It changes when a message or reply text arrives at
 * the end, never when older history comes in at the top (src/data/follow-end.ts).
 */
export function tailOf(state: ConversationState): string {
  const last = state.transcript?.messages.at(-1);
  const reply = state.reply;
  return [
    last ? `${last.seq}:${last.id}` : '',
    state.pending ?? '',
    reply ? `${reply.text.length}:${reply.tool ?? ''}:${reply.error ?? ''}:${state.unreconciled}` : '',
  ].join('|');
}

const RUN_POLLS = 40;
const RUN_POLL_MS = 1500;

export class Conversation<M extends TranscriptMessage = TranscriptMessage> {
  state: ConversationState<M> = CLOSED_CONVERSATION;
  private listeners = new Set<() => void>();
  private abort = new AbortController();
  /** What was loaded when the exchange on screen began. */
  private start: ExchangeStart = exchangeStart(null);
  private disposed = false;

  constructor(private deps: ConversationDeps<M>) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = () => this.state;

  private live() {
    return !this.disposed && this.deps.stillCurrent();
  }

  private set(patch: Partial<ConversationState<M>>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private onEvent = (event: ChatEvent) => {
    if (!this.live()) return;
    const reply = applyEvent(this.state.reply ?? EMPTY_REPLY, event);
    this.set({ reply, ...(reply.title ? { title: reply.title } : {}) });
  };

  /** Read the title and the latest page, then follow a reply that is being written. */
  async open(): Promise<void> {
    const [title, page] = await Promise.all([this.deps.title(), this.deps.latestPage()]);
    if (!this.live()) return;
    if ((!title.ok && (title.status === 404 || title.status === 403)) || (!page.ok && page.status === 404)) {
      this.set({ missing: true });
      return;
    }
    if (title.ok) this.set({ title: title.data.title });
    if (page.ok) this.set({ transcript: withLatest(this.state.transcript, page.data), loadFailed: false });
    else if (!this.state.transcript) this.set({ loadFailed: true });
    await this.followActive();
  }

  /** Back in view: catch up with a reply written meanwhile. */
  async refocus(): Promise<void> {
    if (this.state.busy || this.state.missing) return;
    if (this.state.unreconciled) {
      await this.reconcile();
      return;
    }
    const page = await this.deps.latestPage();
    if (!this.live()) return;
    if (page.ok) this.set({ transcript: withLatest(this.state.transcript, page.data), loadFailed: false });
    await this.followActive();
  }

  async loadOlder(): Promise<void> {
    const before = this.state.transcript?.before;
    if (before == null || this.state.loadingOlder) return;
    this.set({ loadingOlder: true });
    const page = await this.deps.olderPage(before);
    if (!this.live()) return;
    this.set({
      loadingOlder: false,
      ...(page.ok && this.state.transcript ? { transcript: withOlder(this.state.transcript, page.data) } : {}),
    });
  }

  async send(text: string, images: readonly SentImage[] = []): Promise<SendResult> {
    const message = text.trim();
    if ((!message && !images.length) || this.state.busy) return { sent: false, restore: text, notice: 'busy', message: '', status: 409 };
    this.start = exchangeStart(this.state.transcript);
    this.set({ pending: message, pendingImages: images, reply: EMPTY_REPLY, busy: true, unreconciled: false, streamFailed: false });
    const outcome = await this.deps.send(message, this.onEvent, this.abort.signal, images);
    if (!outcome.ok) {
      // closed meanwhile: still say how the send ended, so a queued message is not taken as sent
      const notice = outcome.status === 0 ? 'offline' : outcome.status === 409 ? 'busy' : 'failed';
      const failed = { sent: false, restore: text, notice, message: outcome.message, status: outcome.status } as const;
      if (!this.live()) return failed;
      this.set({ pending: null, pendingImages: [], reply: null, busy: false });
      // a reply is still being written: keep my words and follow that reply
      if (notice === 'busy') void this.followActive();
      return failed;
    }
    if (!this.live()) return { sent: true };
    if (!outcome.finished) await this.waitForRun();
    await this.reconcile();
    return { sent: true };
  }

  /** Read the saved transcript again for the exchange on screen. */
  async reconcile(): Promise<void> {
    if (!this.live()) return;
    this.set({ busy: true });
    const page = await this.deps.latestPage();
    if (!this.live()) return;
    if (page.ok && holdsNewReply(page.data, this.start)) {
      this.set({
        transcript: withLatest(this.state.transcript, page.data),
        pending: null,
        pendingImages: [],
        reply: null,
        busy: false,
        unreconciled: false,
        streamFailed: false,
        loadFailed: false,
      });
      return;
    }
    // the read failed or the reply is not saved yet: the exchange stays, with a retry
    this.set({ busy: false, unreconciled: this.state.pending !== null || this.state.reply !== null });
  }

  private async followActive(): Promise<void> {
    const run = await this.deps.runActive();
    if (!this.live() || !run.ok || !run.data.active || this.state.busy) return;
    this.start = exchangeStart(this.state.transcript);
    this.set({ reply: EMPTY_REPLY, busy: true, unreconciled: false, streamFailed: false });
    const outcome = await this.deps.follow(this.onEvent, this.abort.signal);
    if (!this.live()) return;
    if (!outcome.ok) this.set({ streamFailed: true });
    if (!outcome.ok || !outcome.finished) await this.waitForRun();
    await this.reconcile();
  }

  private async waitForRun(): Promise<void> {
    for (let i = 0; i < RUN_POLLS; i += 1) {
      const run = await this.deps.runActive();
      if (!this.live() || !run.ok || !run.data.active) return;
      await this.deps.wait(RUN_POLL_MS);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    this.listeners.clear();
  }
}
