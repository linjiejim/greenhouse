import type { DbClient } from '@greenhouse/db';
import type { NotifyTransport } from './hub.js';

/**
 * Realtime fan-out between API processes over Postgres LISTEN / NOTIFY. Every NOTIFY goes out
 * through `sender`, a client of exactly one connection: queued and pipelined on it, they commit
 * and arrive in the order they were sent (the frames of a reply, then its final message), and it
 * reconnects by itself after the database dropped it.
 */
export function pgTransport(sql: DbClient['sql'], sender: DbClient['sql']): NotifyTransport {
  return {
    async notify(channel, payload) {
      await sender.notify(channel, payload);
    },
    async listen(channel, onPayload) {
      const subscription = await sql.listen(channel, onPayload);
      return () => subscription.unlisten();
    },
  };
}
