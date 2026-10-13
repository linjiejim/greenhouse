/**
 * Two API processes on one database: they never claim the same job, and two notifications from
 * one source published by both at the same moment still make one message.
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import { getDb, jobs, members, newId, notifications } from '@greenhouse/db';
import { createServices } from '../../../app.js';
import { loadConfig } from '../../../config/index.js';
import { claimJobs, enqueueJob } from '../../../jobs.js';
import { startFakeSmtp, type FakeSmtp } from './fakes.js';

const createdMembers: string[] = [];
const testKind = `test_claim_${newId('job')}`;
let smtp: FakeSmtp | null = null;

afterEach(async () => {
  await smtp?.close();
  smtp = null;
});

afterAll(async () => {
  await getDb().delete(jobs).where(eq(jobs.kind, testKind));
  if (createdMembers.length) {
    const ids = (
      await getDb()
        .select({ id: notifications.id })
        .from(notifications)
        .where(inArray(notifications.memberId, createdMembers))
    ).map((row) => row.id);
    for (const id of ids)
      await getDb()
        .delete(jobs)
        .where(like(jobs.dedupeKey, `deliver:${id}:%`));
    await getDb().delete(notifications).where(inArray(notifications.memberId, createdMembers));
    await getDb().delete(members).where(inArray(members.id, createdMembers));
  }
});

function apiProcess(env: Record<string, string>) {
  return createServices(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://unused/test',
      TOKEN_SIGNING_KEY: 'a'.repeat(64),
      PROVIDER_TOKEN_ENCRYPTION_KEY: 'b'.repeat(64),
      PUBLIC_URL: 'http://greenhouse.test',
      ...env,
    }),
  );
}

describe('two processes', () => {
  it('never claim the same job', async () => {
    for (let n = 0; n < 30; n++) {
      await enqueueJob({ kind: testKind, dedupeKey: `${testKind}:${n}`, payload: { n } });
    }
    const [a, b] = await Promise.all([
      claimJobs([testKind], 'process-a', { limit: 20, leaseMs: 60_000 }),
      claimJobs([testKind], 'process-b', { limit: 20, leaseMs: 60_000 }),
    ]);
    const ids = [...a, ...b].map((job) => job.id);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
  });

  it('make one message of two notifications from one source published at once', async () => {
    smtp = await startFakeSmtp();
    const env = {
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtp.port),
      SMTP_SECURITY: 'none',
      SMTP_FROM: 'gh@acme.com',
    };
    const [one, two] = [apiProcess(env), apiProcess(env)];
    const id = newId('member');
    createdMembers.push(id);
    await getDb()
      .insert(members)
      .values({
        id,
        email: `${id.toLowerCase()}@example.com`,
        name: 'Lin',
        status: 'active',
        notificationSettings: { categories: { runs: { email: true } } },
      });
    const publish = (process: typeof one, n: number) =>
      process.notifications.publish({
        memberId: id,
        kind: 'run_done',
        title: `Run ${n}`,
        targetType: 'conversation',
        targetId: 'cnv_race',
        dedupeKey: `race:${n}`,
      });
    await Promise.all([publish(one, 1), publish(two, 2)]);
    const published = await getDb().select().from(notifications).where(eq(notifications.memberId, id));
    expect(published).toHaveLength(2);
    const queued = await getDb()
      .select()
      .from(jobs)
      .where(
        inArray(
          jobs.dedupeKey,
          published.map((row) => `deliver:${row.id}:email`),
        ),
      );
    expect(queued.map((job) => job.status).sort()).toEqual(['pending', 'suppressed']);

    // Both workers run at once: the message goes out once, saying it stands for two.
    await Promise.all([one.channels.runOnce(), two.channels.runOnce()]);
    expect(smtp.mails).toHaveLength(1);
    expect(smtp.mails[0]!.raw).toContain('2');
  });
});
