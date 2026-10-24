/**
 * Queued messages (rules in ../data/outbox.ts), kept on this phone per station + member and read
 * again when either changes. `useOutboxFlush()` (root layout) sends them when the app comes to the
 * foreground and every so often while any wait: a new conversation is made first when needed.
 * A conversation open on screen sends its own (`claimConversation`), so its reply streams there.
 * A message the station refuses (not just unreachable) is dropped with an alert.
 */

import { useEffect } from 'react';
import { AppState } from 'react-native';
import { create } from 'zustand';
import { createSession } from '../api/assistant';
import { sendMessage } from '../chat/send';
import { captureIdentity } from '../data/identity';
import { dequeue, enqueue, nextToSend, parseOutbox, type QueuedTurn } from '../data/outbox';
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

export function queueTurn(turn: Omit<QueuedTurn, 'id' | 'createdAt'>): void {
  save(enqueue(useOutbox.getState().items, { ...turn, id: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, createdAt: Date.now() }));
}

export function unqueueTurn(id: string): void {
  save(dequeue(useOutbox.getState().items, id));
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

let flushing = false;

/** Send what waits, once; the station still unreachable leaves it queued. */
export async function flushOutbox(): Promise<void> {
  if (flushing || !useAuth.getState().user) return;
  flushing = true;
  try {
    const current = captureIdentity();
    for (const turn of nextToSend(useOutbox.getState().items, new Set(claimed.keys()))) {
      if (!current()) return;
      let sessionId = turn.sessionId;
      if (!sessionId) {
        const made = await createSession();
        if (!current()) return;
        if (!made.ok) {
          if (made.status === 0) return;
          unqueueTurn(turn.id);
          alertError(t('conversation.queuedFailed'), made.message || undefined);
          continue;
        }
        sessionId = made.data.id;
      }
      const outcome = await sendMessage(sessionId, turn.text, () => {}, undefined, turn.images);
      if (!current()) return;
      if (!outcome.ok && outcome.status === 0) {
        // still offline: keep it, and keep the conversation it now has
        if (!turn.sessionId) save(useOutbox.getState().items.map((item) => (item.id === turn.id ? { ...item, sessionId } : item)));
        return;
      }
      unqueueTurn(turn.id);
      if (!outcome.ok) alertError(t('conversation.queuedFailed'), outcome.message || undefined);
    }
  } finally {
    flushing = false;
  }
}

/** Root layout: send queued messages on foreground and every 20 s while any wait. */
export function useOutboxFlush(): void {
  const waiting = useOutbox((s) => s.items.length > 0);
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
