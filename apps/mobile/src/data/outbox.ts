/**
 * Messages written while the station could not be reached, waiting to go. React-free
 * (./outbox.test.ts). A queued message belongs to a conversation (or starts a new one, `sessionId`
 * null) and keeps its words and its already-uploaded pictures; files cannot be queued (their
 * upload needs the station). They go oldest first, one at a time per conversation.
 *
 * - The outbox holds at most MAX_QUEUED; when it is full a new message is refused (the composer
 *   keeps the words), never the oldest dropped.
 * - A send that never got an answer may still have arrived (`status: 'unknown'`): the station has
 *   no per-turn dedup id, so before it goes again the conversation is read, and a last member
 *   message with the same words written since it was queued counts as delivered (`heldByStation`).
 * - A station that is busy or briefly unavailable (`RETRYABLE`) is tried again later, waiting
 *   longer each time (`retryAt`); a refusal that won't change keeps the message as `failed`, shown
 *   in its conversation with a retry, and holds back the messages after it in that conversation.
 */

import type { MessagePage, TranscriptMessage } from './transcript';

export interface QueuedTurn {
  id: string;
  sessionId: string | null;
  text: string;
  images: { id: string; url: string }[];
  createdAt: number;
  /** Absent: not sent yet. `unknown`: sent without an answer. `failed`: the station refused it. */
  status?: 'unknown' | 'failed';
  /** Retryable refusals so far, and when to try again. */
  attempts?: number;
  retryAt?: number;
  /** The station's words for a refusal. */
  error?: string;
}

export const MAX_QUEUED = 30;

/** Busy (a reply is being written), rate-limited or briefly unavailable: try again later. */
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const BACKOFF_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** Phone and station clocks differ; a match this much older than the queued message still counts. */
const CLOCK_SKEW_MS = 2 * 60_000;

export function parseOutbox(saved: unknown): QueuedTurn[] {
  if (!Array.isArray(saved)) return [];
  return saved.flatMap((raw): QueuedTurn[] => {
    const item = raw as Partial<QueuedTurn> | null;
    if (!item || typeof item.id !== 'string' || typeof item.text !== 'string' || typeof item.createdAt !== 'number') return [];
    const images = Array.isArray(item.images)
      ? item.images.filter((image): image is { id: string; url: string } => !!image && typeof image.id === 'string' && typeof image.url === 'string')
      : [];
    return [
      {
        id: item.id,
        sessionId: typeof item.sessionId === 'string' ? item.sessionId : null,
        text: item.text,
        images,
        createdAt: item.createdAt,
        ...(item.status === 'unknown' || item.status === 'failed' ? { status: item.status } : {}),
        ...(typeof item.attempts === 'number' ? { attempts: item.attempts } : {}),
        ...(typeof item.retryAt === 'number' ? { retryAt: item.retryAt } : {}),
        ...(typeof item.error === 'string' ? { error: item.error } : {}),
      },
    ];
  });
}

/** The list with `turn` added, or null when the outbox is full (nothing is dropped). */
export function enqueue(list: readonly QueuedTurn[], turn: QueuedTurn): QueuedTurn[] | null {
  const rest = list.filter((item) => item.id !== turn.id);
  if (rest.length >= MAX_QUEUED) return null;
  return [...rest, turn];
}

export function dequeue(list: readonly QueuedTurn[], id: string): QueuedTurn[] {
  return list.filter((item) => item.id !== id);
}

export function patchTurn(list: readonly QueuedTurn[], id: string, patch: Partial<QueuedTurn>): QueuedTurn[] {
  return list.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

/** Whether `turn` may go now: not refused for good, and not waiting out a retry. */
export function due(turn: QueuedTurn, now: number): boolean {
  return turn.status !== 'failed' && (turn.retryAt ?? 0) <= now;
}

/**
 * The next message to send for each conversation (and every new-conversation message), oldest
 * first. A conversation's oldest message holds back the rest while it waits or has failed.
 */
export function nextToSend(list: readonly QueuedTurn[], skip: ReadonlySet<string>, now = Date.now()): QueuedTurn[] {
  const seen = new Set<string>();
  const out: QueuedTurn[] = [];
  for (const item of [...list].sort((a, b) => a.createdAt - b.createdAt)) {
    if (item.sessionId === null) {
      if (due(item, now)) out.push(item);
      continue;
    }
    if (skip.has(item.sessionId) || seen.has(item.sessionId)) continue;
    seen.add(item.sessionId);
    if (due(item, now)) out.push(item);
  }
  return out;
}

/** How a send attempt ended for the message. `unknown`: no answer, it may have arrived. */
export type Delivery = 'sent' | 'unknown' | 'retry' | 'rejected';

export function deliveryOf(outcome: { ok: true } | { ok: false; status: number }): Delivery {
  if (outcome.ok) return 'sent';
  if (outcome.status === 0) return 'unknown';
  return RETRYABLE.has(outcome.status) ? 'retry' : 'rejected';
}

/** What the queued message becomes after a send attempt that did not deliver it. */
export function afterAttempt(turn: QueuedTurn, delivery: Exclude<Delivery, 'sent'>, message: string, now = Date.now()): Partial<QueuedTurn> {
  if (delivery === 'unknown') return { status: 'unknown' };
  if (delivery === 'rejected') return { status: 'failed', error: message, retryAt: undefined };
  const attempts = (turn.attempts ?? 0) + 1;
  return { status: undefined, attempts, retryAt: now + Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (attempts - 1)) };
}

/** Whether the conversation already holds a message that was sent without an answer. */
export function heldByStation(page: MessagePage<TranscriptMessage & { created_at?: string }>, turn: QueuedTurn): boolean {
  const last = [...page.messages].reverse().find((message) => message.role === 'user');
  if (!last || last.content.trim() !== turn.text.trim()) return false;
  const at = last.created_at ? Date.parse(last.created_at) : NaN;
  return Number.isNaN(at) || at >= turn.createdAt - CLOCK_SKEW_MS;
}
