/**
 * Delivers realtime events to members' open sockets. Events published in one process reach
 * sockets in others through Postgres NOTIFY (blue/green slots share one database); without a
 * listener (tests, a single process) delivery is local only.
 *
 * A NOTIFY payload holds under 8000 bytes, so a long recipient list is split across several. An
 * event that does not fit even alone reaches the other processes as a hint to refetch: a long
 * reply's final message as `conversation.resync` (their clients fetch the messages after it),
 * records too many to name as `records.changed` with an empty list. Anything else stays local.
 */

import { randomUUID } from 'node:crypto';
import type { RealtimeEvent } from '@greenhouse/contract';
import { logger } from '@greenhouse/utils/logger';

export type Deliver = (event: RealtimeEvent) => void;

const CHANNEL = 'greenhouse_events';
/** NOTIFY payloads must stay under 8000 bytes. */
const MAX_NOTIFY_BYTES = 7000;

export interface NotifyTransport {
  notify(channel: string, payload: string): Promise<void>;
  listen(channel: string, onPayload: (payload: string) => void): Promise<() => Promise<void>>;
}

/** What other processes get instead of an event too big to pass between them. */
function resyncOf(event: RealtimeEvent): RealtimeEvent | null {
  switch (event.type) {
    case 'message.created':
    case 'message.updated': {
      const { message } = event.data;
      return {
        type: 'conversation.resync',
        data: { conversation_id: message.conversation_id, after_seq: Math.max(0, message.seq - 1) },
      };
    }
    case 'records.changed':
      // Too many records to name: an empty list means many changed.
      return { type: 'records.changed', data: { ...event.data, records: [] } };
    default:
      return null;
  }
}

/** The NOTIFY payloads of one event, recipients split so each fits; null when the event alone does not. */
function payloads(origin: string, memberIds: readonly string[], event: RealtimeEvent): string[] | null {
  const head = `{"origin":${JSON.stringify(origin)},"event":${JSON.stringify(event)},"to":[`;
  const fixed = Buffer.byteLength(head) + 2;
  if (fixed > MAX_NOTIFY_BYTES - 64) return null;
  const out: string[] = [];
  let batch: string[] = [];
  let size = fixed;
  for (const id of memberIds) {
    const entry = JSON.stringify(id);
    const cost = Buffer.byteLength(entry) + 1;
    if (batch.length && size + cost > MAX_NOTIFY_BYTES) {
      out.push(`${head}${batch.join(',')}]}`);
      batch = [];
      size = fixed;
    }
    batch.push(entry);
    size += cost;
  }
  if (batch.length) out.push(`${head}${batch.join(',')}]}`);
  return out;
}

export function createHub() {
  const origin = randomUUID();
  const sockets = new Map<string, Set<Deliver>>();
  const observers = new Set<Deliver>();
  let transport: NotifyTransport | null = null;
  let unlisten: (() => Promise<void>) | null = null;

  function local(memberIds: readonly string[], event: RealtimeEvent) {
    for (const memberId of new Set(memberIds)) {
      for (const deliver of sockets.get(memberId) ?? []) {
        try {
          deliver(event);
        } catch (error) {
          logger.warn('[realtime] a socket failed to take an event', { error: String(error) });
        }
      }
    }
  }

  function observed(event: RealtimeEvent) {
    for (const observer of observers) {
      try {
        observer(event);
      } catch (error) {
        logger.warn('[realtime] an observer failed on an event', { error: String(error) });
      }
    }
  }

  return {
    /** A socket of this member; returns the unsubscribe. */
    subscribe(memberId: string, deliver: Deliver): () => void {
      const set = sockets.get(memberId) ?? new Set();
      set.add(deliver);
      sockets.set(memberId, set);
      return () => {
        set.delete(deliver);
        if (!set.size) sockets.delete(memberId);
      };
    },

    /**
     * Sees every event this process publishes or receives from another one, whoever it is for:
     * for caches that events invalidate (the people of a conversation). Returns the stop.
     */
    observe(observer: Deliver): () => void {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },

    /** Sends to every socket of these members, in every process. */
    publish(memberIds: readonly string[], event: RealtimeEvent): void {
      observed(event);
      if (!memberIds.length) return;
      local(memberIds, event);
      if (!transport) return;
      const to = [...new Set(memberIds)];
      const hint = resyncOf(event);
      const sent = payloads(origin, to, event) ?? (hint ? payloads(origin, to, hint) : null);
      if (!sent) {
        logger.warn('[realtime] an event too big to share reached only this process', { type: event.type });
        return;
      }
      for (const payload of sent) {
        transport.notify(CHANNEL, payload).catch((error: unknown) => {
          logger.warn('[realtime] NOTIFY failed', { error: String(error) });
        });
      }
    },

    async connect(next: NotifyTransport): Promise<void> {
      transport = next;
      unlisten = await next.listen(CHANNEL, (raw) => {
        try {
          const message = JSON.parse(raw) as { origin: string; to: string[]; event: RealtimeEvent };
          if (message.origin === origin) return;
          observed(message.event);
          local(message.to, message.event);
        } catch {
          logger.warn('[realtime] dropped a malformed NOTIFY payload');
        }
      });
    },

    async close(): Promise<void> {
      await unlisten?.();
      unlisten = null;
      transport = null;
    },

    /** Open sockets, for tests and health. */
    count(memberId?: string): number {
      if (memberId) return sockets.get(memberId)?.size ?? 0;
      return [...sockets.values()].reduce((sum, set) => sum + set.size, 0);
    },
  };
}

export type Hub = ReturnType<typeof createHub>;
