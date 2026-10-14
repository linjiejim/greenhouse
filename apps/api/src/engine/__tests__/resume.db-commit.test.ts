/**
 * A background run whose process dies after a tool step finished is taken up by another
 * process, which continues from the recorded steps: the tool is not run again, and the model
 * sees what it returned.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getDb, members, newId, runs, runSteps } from '@greenhouse/db';
import { createServices } from '../../app.js';
import { hashPassword } from '../../auth/password.js';
import { loadConfig } from '../../config/index.js';
import { TEST_PASSWORD } from '../../testing.js';
import { defineTool } from '../tools/define.js';
import { gate, scriptedModel, text, toolCall } from './model.js';

const created: string[] = [];

afterAll(async () => {
  if (!created.length) return;
  await getDb().delete(runs).where(inArray(runs.ownerId, created));
  await getDb().delete(members).where(inArray(members.id, created));
});

function apiProcess(languageModel: ReturnType<typeof scriptedModel>['languageModel'], looked: string[]) {
  const lookup = defineTool({
    name: 'lookup',
    description: 'Look a fact up.',
    input: z.object({ q: z.string() }),
    risk: 'read',
    async execute(args) {
      looked.push(args.q);
      return { fact: `${args.q} is 42` };
    },
  });
  return createServices(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://unused/test',
      TOKEN_SIGNING_KEY: 'a'.repeat(64),
      PROVIDER_TOKEN_ENCRYPTION_KEY: 'b'.repeat(64),
    }),
    { languageModel, tools: [lookup] },
  );
}

describe('a background run across processes', () => {
  it('continues from its last finished step in another process, without running the tool again', async () => {
    const looked: string[] = [];
    const never = gate();
    const model = scriptedModel([
      toolCall('lookup', { q: 'alpha' }),
      { parts: text('This never arrives.'), gate: never.promise },
      text('Alpha is 42.'),
    ]);
    const a = apiProcess(model.languageModel, looked);
    const b = apiProcess(model.languageModel, looked);
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
    const run = await a.engine.background.start({
      agentId: main.agentId!,
      ownerId: lin,
      requestedBy: lin,
      title: 'Alpha',
      brief: 'Find out what alpha is.',
      source: 'conversation',
      sourceId: main.id,
      conversationId: main.id,
    });
    // Process A looks alpha up, records the step, and is waiting on the model when it dies.
    for (let wait = 0; wait < 100 && model.calls() < 2; wait++) await new Promise((r) => setTimeout(r, 20));
    expect(model.calls()).toBe(2);
    await a.engine.shutdown({ graceMs: 0 });
    await getDb()
      .update(runs)
      .set({ status: 'running', leaseOwner: 'api-dead', leaseExpiresAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(runs.id, run.id));

    await b.engine.background.sweep();
    await b.engine.idle();
    const [done] = await getDb().select().from(runs).where(eq(runs.id, run.id));
    expect(done).toMatchObject({ status: 'succeeded', attempt: 2, output: { text: 'Alpha is 42.' } });
    expect(looked).toEqual(['alpha']);
    expect(model.calls()).toBe(3);
    // B's model went on from A's step: the call and what it returned.
    const resumed = JSON.stringify(model.prompts[2]);
    expect(resumed).toContain('alpha is 42');
    expect(resumed).toContain('Find out what alpha is.');
    const steps = await getDb()
      .select({ key: runSteps.key, attempt: runSteps.attempt })
      .from(runSteps)
      .where(and(eq(runSteps.runId, run.id), eq(runSteps.kind, 'model')))
      .orderBy(asc(runSteps.key));
    expect(steps).toEqual([
      { key: 'model:1', attempt: 1 },
      { key: 'model:2', attempt: 2 },
    ]);

    await b.engine.shutdown();
  }, 30_000);
});
