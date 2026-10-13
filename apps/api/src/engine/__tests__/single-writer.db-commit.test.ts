/**
 * Two API processes (two engines on one database) take messages for the same conversation at
 * the same time: one turn answers at a time, nothing is lost, and the transcript has one order.
 */

import { asc, eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { getDb, members, messageReceipts, messages, newId, runs } from '@greenhouse/db';
import { createApp, createServices } from '../../app.js';
import { hashPassword } from '../../auth/password.js';
import { loadConfig } from '../../config/index.js';
import { TEST_PASSWORD } from '../../testing.js';
import { scriptedModel, text } from './model.js';

const created: string[] = [];

afterAll(async () => {
  if (!created.length) return;
  await getDb().delete(runs).where(inArray(runs.ownerId, created));
  await getDb().delete(members).where(inArray(members.id, created));
});

function apiProcess(languageModel: ReturnType<typeof scriptedModel>['languageModel']) {
  const services = createServices(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://unused/test',
      TOKEN_SIGNING_KEY: 'a'.repeat(64),
      PROVIDER_TOKEN_ENCRYPTION_KEY: 'b'.repeat(64),
    }),
    { languageModel },
  );
  return { services, app: createApp(services) };
}

describe('the single writer across processes', () => {
  it('answers every message, one turn at a time, in one order', async () => {
    const model = scriptedModel([text('ok')]);
    const a = apiProcess(model.languageModel);
    const b = apiProcess(model.languageModel);
    const id = newId('member');
    created.push(id);
    await getDb()
      .insert(members)
      .values({
        id,
        email: `${id.toLowerCase()}@example.com`,
        name: 'Lin',
        status: 'active',
        role: 'member',
        passwordHash: await hashPassword(TEST_PASSWORD),
      });
    const main = await a.services.conversations.ensureMain(id);

    const sends = Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? b : a).services.engine.post(id, main.id, {
        content: `message ${index}`,
        attachments: [],
        mentions: [],
      }),
    );
    const results = await Promise.all(sends);
    await Promise.all([a.services.engine.idle(), b.services.engine.idle()]);
    // A turn finishing in one process may have left the queue for the other; settle both.
    for (let round = 0; round < 5; round++) {
      await a.services.engine.sweep();
      await b.services.engine.sweep();
      await Promise.all([a.services.engine.idle(), b.services.engine.idle()]);
    }

    expect(results.filter((result) => !result.queued).length).toBeGreaterThanOrEqual(1);
    const transcript = await getDb()
      .select()
      .from(messages)
      .where(eq(messages.conversationId, main.id))
      .orderBy(asc(messages.seq));
    expect(transcript.map((row) => row.seq)).toEqual(transcript.map((_, index) => index + 1));
    const userIds = transcript.filter((row) => row.role === 'user').map((row) => row.id);
    expect(userIds).toHaveLength(8);
    const receipts = await getDb().select().from(messageReceipts).where(inArray(messageReceipts.messageId, userIds));
    expect(receipts.every((receipt) => receipt.status === 'answered')).toBe(true);
    const turns = await getDb().select().from(runs).where(eq(runs.conversationId, main.id));
    expect(turns.every((turn) => turn.status === 'succeeded')).toBe(true);
    // Overlapping turns would show as replies interleaved with each other's running time.
    const spans = turns
      .map((turn) => [Date.parse(turn.startedAt!), Date.parse(turn.finishedAt!)] as const)
      .sort((x, y) => x[0] - y[0]);
    for (let index = 1; index < spans.length; index++)
      expect(spans[index]![0]).toBeGreaterThanOrEqual(spans[index - 1]![1] - 5);
  });
});
