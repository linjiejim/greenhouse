/**
 * Delivers realtime events to members' open sockets. Events published in one process reach
 * sockets in others through Postgres NOTIFY (blue/green slots share one database); without a
 * listener (tests, a single process) delivery is local only.
 */

import { randomUUID } from 'node:crypto';
import type { RealtimeEvent } from '@greenhouse/contract';
import { logger } from '@greenhouse/utils/logger';

export type Deliver = (event: RealtimeEvent) => void;

const CHANNEL = 'greenhouse_events';
/** NOTIFY payloads must stay under 8000 bytes; bigger events go local-only plus a resync hint. */
const MAX_NOTIFY_BYTES = 7000;

export interface NotifyTransport {
  notify(channel: string, payload: string): Promise<void>;
  listen(channel: string, onPayload: (payload: string) => void): Promise<() => Promise<void>>;
}

export function createHub() {
  const origin = randomUUID();
  const sockets = new Map<string, Set<Deliver>>();
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

    /** Sends to every socket of these members, in every process. */
    publish(memberIds: readonly string[], event: RealtimeEvent): void {
      if (!memberIds.length) return;
      local(memberIds, event);
      if (!transport) return;
      const payload = JSON.stringify({ origin, to: memberIds, event });
      if (Buffer.byteLength(payload) > MAX_NOTIFY_BYTES) return;
      transport.notify(CHANNEL, payload).catch((error: unknown) => {
        logger.warn('[realtime] NOTIFY failed', { error: String(error) });
      });
    },

    async connect(next: NotifyTransport): Promise<void> {
      transport = next;
      unlisten = await next.listen(CHANNEL, (raw) => {
        try {
          const message = JSON.parse(raw) as { origin: string; to: string[]; event: RealtimeEvent };
          if (message.origin !== origin) local(message.to, message.event);
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
