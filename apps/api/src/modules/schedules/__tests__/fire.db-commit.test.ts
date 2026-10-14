/**
 * A schedule's firing queues its run in the transaction that claims it: the process that fired
 * it may die right after the commit, and the run is still there for another process to take.
 * Two processes ticking at once fire it once, and firings missed while nothing ran collapse.
 */

import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { getDb, members, newId, runs, schedules } from '@greenhouse/db';
import { createServices } from '../../../app.js';
import { hashPassword } from '../../../auth/password.js';
import { loadConfig } from '../../../config/index.js';
import { scriptedModel, text } from '../../../engine/__tests__/model.js';
import { TEST_PASSWORD } from '../../../testing.js';

const created: string[] = [];

afterAll(async () => {
  if (!created.length) return;
  await getDb().delete(runs).where(inArray(runs.ownerId, created));
  await getDb().delete(members).where(inArray(members.id, created));
});

function apiProcess(languageModel: ReturnType<typeof scriptedModel>['languageModel']) {
  return createServices(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://unused/test',
      TOKEN_SIGNING_KEY: 'a'.repeat(64),
      PROVIDER_TOKEN_ENCRYPTION_KEY: 'b'.repeat(64),
    }),
    { languageModel },
  );
}

describe('a schedule firing across processes', () => {
  it('survives the process that fired it, fires once, and catches up once', async () => {
    const model = scriptedModel([text('Digest written.')]);
    const a = apiProcess(model.languageModel);
    const b = apiProcess(model.languageModel);
    const c = apiProcess(model.languageModel);
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
    await a.conversations.ensureMain(id);
    const schedule = await a.schedules.create(id, {
      agent_id: 'main',
      name: 'Hourly digest',
      brief: 'Write the digest.',
      cron: '0 * * * *',
      timezone: 'UTC',
    });
    // Down for three days: 72 firings were missed.
    await getDb()
      .update(schedules)
      .set({ nextRunAt: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString() })
      .where(eq(schedules.id, schedule.id));

    // Process A fires it and dies right after the commit: it never runs what it queued.
    await a.engine.shutdown();
    expect(await a.schedules.tick()).toBe(1);
    // B and C tick at the same moment: nothing is due any more.
    expect((await Promise.all([b.schedules.tick(), c.schedules.tick()])).reduce((x, y) => x + y)).toBe(0);
    const queued = await getDb().select().from(runs).where(eq(runs.sourceId, schedule.id));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: 'queued', source: 'schedule', kind: 'background', attempt: 0 });
    const [moved] = await getDb().select().from(schedules).where(eq(schedules.id, schedule.id));
    expect(moved).toMatchObject({ lastRunId: queued[0]!.id, lastStatus: 'queued', runCount: 1 });
    expect(Date.parse(moved!.nextRunAt!)).toBeGreaterThan(Date.now());

    // Another process takes the run from the queue.
    await b.engine.background.sweep();
    await b.engine.idle();
    const [done] = await getDb().select().from(runs).where(eq(runs.id, queued[0]!.id));
    expect(done).toMatchObject({ status: 'succeeded', attempt: 1, output: { text: 'Digest written.' } });
    const [after] = await getDb().select().from(schedules).where(eq(schedules.id, schedule.id));
    expect(after).toMatchObject({ lastStatus: 'succeeded', runCount: 1 });
    expect(model.calls()).toBe(1);

    await Promise.all([b.engine.shutdown(), c.engine.shutdown()]);
  }, 30_000);
});
