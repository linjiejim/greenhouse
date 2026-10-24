/**
 * Queued messages (rules in ../data/outbox.ts), kept on this phone per station + member and read
 * again when either changes. `useOutboxFlush()` (root layout) sends them when the app comes to the
 * foreground and every so often while any wait: a new conversation is made first when needed.
 * A conversation open on screen sends its own (`claimConversation`), so its reply streams there.
 *
 * Both senders go through `deliverQueued`: a message is claimed for the one attempt (a second
 * sender skips it), is checked to still be queued right before it goes, and leaves the outbox only
 * when the station accepted it (or says it already saved that turn: `client_turn_id`).
 */

import { useEffect } from 'react';
import { AppState } from 'react-native';
import { create } from 'zustand';
import { createSession } from '../api/assistant';
import { sendMessage } from '../chat/send';
import { captureIdentity } from '../data/identity';
import {
  afterAttempt,
  deliveryOf,
  dequeue,
  due,
  enqueue,
  newTurnId,
  nextToSend,
  parseOutbox,
  patchTurn,
  type Delivery,
  type QueuedTurn,
} from '../data/outbox';
import { t } from '../lib/i18n';
import { alertError } from '../ui/dialogs';
import { useAuth } from './auth';
import { readOffline, writeOffline } from './offline';
import { useStations } from './stations';

const KIND = 'outbox';

export const useOutbox = create<{ items: QueuedTurn[] }>(() => ({ items: [] }));

let identity = '';
const follow = () => {
  const next = `${useStations.getState().activeId ?? ''}:${useAuth.getState().user?.id ?? ''}`;
  if (next === identity) return;
  identity = next;
  useOutbox.setState({ items: [] });
  if (!useAuth.getState().user) return;
  const current = captureIdentity();
  void readOffline(KIND).then((saved) => {
    if (current()) useOutbox.setState({ items: parseOutbox(saved) });
  });
};
useAuth.subscribe(follow);
useStations.subscribe(follow);

function save(items: QueuedTurn[]): void {
  useOutbox.setState({ items });
  writeOffline(KIND, items);
}

const queued = (id: string) => useOutbox.getState().items.find((item) => item.id === id);

/**
 * Queue a message; false when the outbox is full (nothing is dropped, the caller keeps the words).
 * A send that falls back into the queue passes the turn id it was sent with, so a retry is the
 * same turn to the station.
 */
export function queueTurn(turn: Omit<QueuedTurn, 'id' | 'createdAt'> & { id?: string }): boolean {
  const next = enqueue(useOutbox.getState().items, { ...turn, id: turn.id ?? newTurnId(), createdAt: Date.now() });
  if (!next) return false;
  save(next);
  return true;
}

export function unqueueTurn(id: string): void {
  save(dequeue(useOutbox.getState().items, id));
}

function patch(id: string, change: Partial<QueuedTurn>): void {
  save(patchTurn(useOutbox.getState().items, id, change));
}

/** Conversations on screen send their own queued messages. */
const claimed = new Map<string, number>();
export function claimConversation(sessionId: string): () => void {
  claimed.set(sessionId, (claimed.get(sessionId) ?? 0) + 1);
  return () => {
    const n = (claimed.get(sessionId) ?? 1) - 1;
    if (n <= 0) claimed.delete(sessionId);
    else claimed.set(sessionId, n);
  };
}

/** Messages being sent right now, by whichever sender claimed them. */
const inFlight = new Set<string>();

export type SendAttempt = { ok: true } | { ok: false; status: number; code?: string; message: string };
type Addressed = QueuedTurn & { sessionId: string };

/**
 * Send one queued message through `send`, once. Skipped (`null`) when another sender has it, it
 * left the outbox, its conversation is on screen (for the background sender), or it is not due
 * (unless `manual`: the member pressed retry). It leaves the outbox only once delivered.
 */
export async function deliverQueued(
  id: string,
  send: (turn: Addressed) => Promise<SendAttempt>,
  options: { manual?: boolean; background?: boolean } = {},
): Promise<Delivery | null> {
  const turn = queued(id);
  if (!turn?.sessionId || inFlight.has(id)) return null;
  if (options.background && claimed.has(turn.sessionId)) return null;
  if (!options.manual && !due(turn, Date.now())) return null;
  const current = captureIdentity();
  const target: Addressed = { ...turn, sessionId: turn.sessionId };
  inFlight.add(id);
  try {
    const attempt = await send(target);
    if (!current()) return null;
    const delivery = deliveryOf(attempt);
    if (delivery === 'sent') unqueueTurn(id);
    else if (queued(id)) patch(id, afterAttempt(queued(id)!, delivery, attempt.ok ? '' : attempt.message));
    return delivery;
  } finally {
    inFlight.delete(id);
  }
}

let flushing = false;

/** Send what waits, once; the station still unreachable leaves it queued. */
export async function flushOutbox(): Promise<void> {
  if (flushing || !useAuth.getState().user) return;
  flushing = true;
  try {
    const current = captureIdentity();
    for (const snapshot of nextToSend(useOutbox.getState().items, new Set(claimed.keys()))) {
      if (!current()) return;
      if (!snapshot.sessionId) {
        // a new conversation first; the message keeps it, so a retry never makes another
        if (inFlight.has(snapshot.id) || !queued(snapshot.id)) continue;
        inFlight.add(snapshot.id);
        let made: Awaited<ReturnType<typeof createSession>>;
        try {
          made = await createSession();
        } finally {
          inFlight.delete(snapshot.id);
        }
        if (!current()) return;
        if (!queued(snapshot.id)) continue;
        if (!made.ok) {
          if (made.status === 0) return;
          unqueueTurn(snapshot.id);
          alertError(t('conversation.queuedFailed'), made.message || undefined);
          continue;
        }
        patch(snapshot.id, { sessionId: made.data.id });
      }
      const delivery = await deliverQueued(
        snapshot.id,
        async (turn) => {
          const outcome = await sendMessage(turn.sessionId, turn.text, () => {}, undefined, turn.images, turn.id);
          return outcome.ok ? { ok: true } : { ok: false, status: outcome.status, code: outcome.code, message: outcome.message };
        },
        { background: true },
      );
      if (!current()) return;
      // no answer from the station: the rest would not get through either
      if (delivery === 'unknown') return;
      if (delivery === 'rejected') alertError(t('conversation.queuedFailed'), queued(snapshot.id)?.error || undefined);
    }
  } finally {
    flushing = false;
  }
}

/** Root layout: send queued messages on foreground and every 20 s while any wait. */
export function useOutboxFlush(): void {
  const waiting = useOutbox((s) => s.items.some((item) => item.status !== 'failed'));
  const member = useAuth((s) => s.user?.id);
  useEffect(() => {
    if (!waiting || !member) return;
    void flushOutbox();
    const timer = setInterval(() => void flushOutbox(), 20_000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void flushOutbox();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [waiting, member]);
}

/** Test hook. */
export function _resetOutbox(): void {
  claimed.clear();
  inFlight.clear();
  flushing = false;
  useOutbox.setState({ items: [] });
}
