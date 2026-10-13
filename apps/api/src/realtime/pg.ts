import type { DbClient } from '@greenhouse/db';
import type { NotifyTransport } from './hub.js';

/** Realtime fan-out between API processes over Postgres LISTEN / NOTIFY. */
export function pgTransport(sql: DbClient['sql']): NotifyTransport {
  return {
    async notify(channel, payload) {
      await sql.notify(channel, payload);
    },
    async listen(channel, onPayload) {
      const subscription = await sql.listen(channel, onPayload);
      return () => subscription.unlisten();
    },
  };
}
