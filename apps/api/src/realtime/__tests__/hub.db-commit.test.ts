/**
 * Two API processes, each with its own hub on Postgres LISTEN / NOTIFY: a member whose socket is
 * on process B sees a reply process A writes, and its final message, too big for NOTIFY, reaches
 * them as a resync hint they catch up from with `?after=`.
 */

import { inArray, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { RealtimeEvent } from '@greenhouse/contract';
import { createDbClient, getDb, members, newId, runs, type DbClient } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/testing';
import { createServices } from '../../app.js';
import { hashPassword } from '../../auth/password.js';
import { loadConfig } from '../../config/index.js';
import { scriptedModel, text } from '../../engine/__tests__/model.js';
import { TEST_PASSWORD } from '../../testing.js';
import { pgTransport } from '../pg.js';

const created: string[] = [];
const clients: DbClient[] = [];

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  if (!created.length) return;
  await getDb().delete(runs).where(inArray(runs.ownerId, created));
  await getDb().delete(members).where(inArray(members.id, created));
});

async function apiProcess(languageModel: ReturnType<typeof scriptedModel>['languageModel']) {
  const services = createServices(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://unused/test',
      TOKEN_SIGNING_KEY: 'a'.repeat(64),
      PROVIDER_TOKEN_ENCRYPTION_KEY: 'b'.repeat(64),
    }),
    { languageModel },
  );
  const client = createDbClient(TEST_DATABASE_URL, { max: 2 });
  const notifier = createDbClient(TEST_DATABASE_URL, { max: 1 });
  clients.push(client, notifier);
  await services.hub.connect(pgTransport(client.sql, notifier.sql));
  return { services, notifier };
}

const until = async (done: () => boolean, ms = 5000) => {
  for (const start = Date.now(); !done() && Date.now() - start < ms; ) await new Promise((r) => setTimeout(r, 20));
};

describe('realtime across processes', () => {
  it('brings a long final reply to a member on the other process', async () => {
    // About 12 KB as JSON: far over what one NOTIFY carries.
    const long = '长 '.repeat(3000).trim();
    const model = scriptedModel([text(long), text('Still here.')]);
    const { services: a, notifier } = await apiProcess(model.languageModel);
    const { services: b } = await apiProcess(model.languageModel);
    const lin = newId('member');
    created.push(lin);
    await getDb()
      .insert(members)
      .values({
        id: lin,
        email: `${lin.toLowerCase()}@example.com`,
        name: 'Lin',
        status: 'active',
        role: 'member',
        passwordHash: await hashPassword(TEST_PASSWORD),
      });
    const main = await a.conversations.ensureMain(lin);
    // Lin's socket is on process B.
    const seen: RealtimeEvent[] = [];
    b.hub.subscribe(lin, (event) => seen.push(event));

    await a.engine.post(lin, main.id, { content: 'tell me a long story', attachments: [], mentions: [] });
    await a.engine.idle();
    await until(() => seen.some((event) => event.type === 'conversation.resync'));

    // The reply streamed over in frames, every one of which fit.
    const frames = seen.filter(
      (event): event is Extract<RealtimeEvent, { type: 'message.delta' }> => event.type === 'message.delta',
    );
    expect(frames.map((frame) => frame.data.text).join('')).toBe(long);
    // The final message did not fit: B got a hint, and catches up from it.
    expect(seen.some((event) => event.type === 'message.updated' && event.data.message.content === long)).toBe(false);
    const hint = seen.find(
      (event): event is Extract<RealtimeEvent, { type: 'conversation.resync' }> => event.type === 'conversation.resync',
    );
    expect(hint?.data.conversation_id).toBe(main.id);
    const page = await b.conversations.messages(lin, main.id, { after: hint!.data.after_seq, limit: 50 });
    expect(page.items[0]).toMatchObject({ role: 'assistant', status: 'complete', content: long });

    // The database drops the connection NOTIFYs leave on (a restart, a failover): the next ones
    // go out on a new connection, and the process carries on.
    const [{ pid }] = await notifier.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
    await getDb().execute(sql`select pg_terminate_backend(${pid})`);
    seen.length = 0;
    await a.engine.post(lin, main.id, { content: 'still there?', attachments: [], mentions: [] });
    await a.engine.idle();
    await until(() => seen.some((event) => event.type === 'message.updated'));
    expect(seen.some((event) => event.type === 'message.updated' && event.data.message.content === 'Still here.')).toBe(
      true,
    );

    await Promise.all([a.engine.shutdown(), b.engine.shutdown(), a.hub.close(), b.hub.close()]);
  }, 30_000);
});
