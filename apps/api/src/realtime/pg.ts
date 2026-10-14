import type { DbClient } from '@greenhouse/db';
import type { NotifyTransport } from './hub.js';

type Reserved = Awaited<ReturnType<DbClient['sql']['reserve']>>;

/**
 * Realtime fan-out between API processes over Postgres LISTEN / NOTIFY. Every NOTIFY leaves on
 * one reserved connection, pipelined, so they commit and arrive in the order they were sent: the
 * frames of a reply and its final message stay in order in every process.
 */
export function pgTransport(sql: DbClient['sql']): NotifyTransport {
  let sender: Promise<Reserved> | null = null;
  return {
    async notify(channel, payload) {
      const current = (sender ??= sql.reserve());
      try {
        const connection = await current;
        await connection`select pg_notify(${channel}, ${payload})`;
      } catch (error) {
        // A broken connection is replaced for the next NOTIFY.
        if (sender === current) {
          sender = null;
          void current.then(
            (connection) => connection.release(),
            () => undefined,
          );
        }
        throw error;
      }
    },
    async listen(channel, onPayload) {
      const subscription = await sql.listen(channel, onPayload);
      return async () => {
        await subscription.unlisten();
        const current = sender;
        sender = null;
        await current?.then(
          (connection) => connection.release(),
          () => undefined,
        );
      };
    },
  };
}
