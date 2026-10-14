/**
 * A decision on a card is a job written with it: the process that settled it may die before
 * carrying it out, and another one does it, exactly once. A second claim of the same job, or a
 * claim taken over from a process that died while the write ran, never runs the write again.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getDb, jobs, members, messages, newId, requests, runs, runSteps } from '@greenhouse/db';
import { createServices } from '../../app.js';
import { hashPassword } from '../../auth/password.js';
import { loadConfig } from '../../config/index.js';
import { DECISION_JOB } from '../../modules/requests/service.js';
import { TEST_PASSWORD } from '../../testing.js';
import { defineTool } from '../tools/define.js';
import { scriptedModel, text, toolCall } from './model.js';

const created: string[] = [];
const cards: string[] = [];

afterAll(async () => {
  if (cards.length) {
    await getDb()
      .delete(jobs)
      .where(
        inArray(
          jobs.dedupeKey,
          cards.map((id) => `${DECISION_JOB}:${id}`),
        ),
      );
  }
  if (!created.length) return;
  await getDb().delete(runs).where(inArray(runs.ownerId, created));
  await getDb().delete(members).where(inArray(members.id, created));
});

function apiProcess(languageModel: ReturnType<typeof scriptedModel>['languageModel'], sent: string[]) {
  const noteSend = defineTool({
    name: 'note_send',
    description: 'Send a note to the team.',
    input: z.object({ text: z.string() }),
    risk: 'write',
    async execute(args) {
      sent.push(args.text);
      return { sent: true };
    },
  });
  return createServices(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://unused/test',
      TOKEN_SIGNING_KEY: 'a'.repeat(64),
      PROVIDER_TOKEN_ENCRYPTION_KEY: 'b'.repeat(64),
    }),
    { languageModel, tools: [noteSend] },
  );
}

async function member() {
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
  return id;
}

const jobOf = async (requestId: string) =>
  (
    await getDb()
      .select()
      .from(jobs)
      .where(eq(jobs.dedupeKey, `${DECISION_JOB}:${requestId}`))
  )[0]!;

const decisionLines = (conversationId: string, requestId: string) =>
  getDb()
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), sql`${messages.event}->>'request_id' = ${requestId}`));

describe('decisions across processes', () => {
  it('are carried out exactly once, by another process when the one that settled them died', async () => {
    const sent: string[] = [];
    // One model for every process: calls happen one after another.
    const model = scriptedModel([
      toolCall('note_send', { text: 'hi' }),
      text('Sent.'),
      toolCall('note_send', { text: 'again' }, 'call_2'),
      text('I will check whether it went out first.'),
    ]);
    const a = apiProcess(model.languageModel, sent);
    const b = apiProcess(model.languageModel, sent);
    const c = apiProcess(model.languageModel, sent);
    const lin = await member();
    const main = await a.conversations.ensureMain(lin);

    const first = await a.engine.post(lin, main.id, { content: 'tell the team hi', attachments: [], mentions: [] });
    await a.engine.idle();
    const [card] = await getDb().select().from(requests).where(eq(requests.runId, first.run_id!));
    cards.push(card!.id);
    expect(card).toMatchObject({ status: 'pending', subject: 'tool_write' });

    // Process A is going away: its decision commits, but A never carries it out.
    await a.engine.shutdown();
    await a.requests.settle(lin, card!.id, { status: 'approved', result: { decision: 'approved' } });
    expect(sent).toEqual([]);
    expect(await jobOf(card!.id)).toMatchObject({ status: 'pending', kind: DECISION_JOB });

    // Two other processes look at once; one of them takes it.
    b.engine.wakeDecisions();
    c.engine.wakeDecisions();
    await Promise.all([b.engine.idle(), c.engine.idle()]);
    expect(sent).toEqual(['hi']);
    const [step] = await getDb().select().from(runSteps).where(eq(runSteps.id, card!.stepId!));
    expect(step!.status).toBe('succeeded');
    const [turn] = await getDb().select().from(runs).where(eq(runs.id, first.run_id!));
    expect(turn!.status).toBe('succeeded');
    expect((await decisionLines(main.id, card!.id)).map((line) => line.content)).toEqual(['已批准：note_send']);
    expect(await jobOf(card!.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(model.calls()).toBe(2);

    // A claim that comes back after the work was done (its process died before settling):
    // the write is never run again and the transcript and the Agent hear about it once.
    for (const progress of [{ keep: true }, { keep: false }]) {
      await getDb()
        .update(jobs)
        .set({ status: 'pending', leaseOwner: null, ...(progress.keep ? {} : { result: null }) })
        .where(eq(jobs.dedupeKey, `${DECISION_JOB}:${card!.id}`));
      b.engine.wakeDecisions();
      await b.engine.idle();
      expect(sent).toEqual(['hi']);
      expect(await decisionLines(main.id, card!.id)).toHaveLength(1);
      expect(model.calls()).toBe(2);
      expect((await jobOf(card!.id)).status).toBe('succeeded');
    }

    // A process died while the approved write ran: whether it went out is unknown, so it is
    // marked uncertain, never run again, and the Agent is told to check.
    const second = await b.engine.post(lin, main.id, { content: 'and again', attachments: [], mentions: [] });
    await b.engine.idle();
    const [again] = await getDb().select().from(requests).where(eq(requests.runId, second.run_id!));
    cards.push(again!.id);
    await a.requests.settle(lin, again!.id, { status: 'approved', result: { decision: 'approved' } });
    await getDb().update(runSteps).set({ status: 'running' }).where(eq(runSteps.id, again!.stepId!));
    await getDb()
      .update(jobs)
      .set({
        status: 'claimed',
        leaseOwner: 'api-dead',
        leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
        attempts: 1,
      })
      .where(eq(jobs.dedupeKey, `${DECISION_JOB}:${again!.id}`));
    c.engine.wakeDecisions();
    await c.engine.idle();
    expect(sent).toEqual(['hi']);
    const [uncertain] = await getDb().select().from(runSteps).where(eq(runSteps.id, again!.stepId!));
    expect(uncertain!.status).toBe('uncertain');
    expect((await decisionLines(main.id, again!.id)).map((line) => line.content)).toEqual([
      '已批准：note_send，结果未知',
    ]);
    const [woken] = await getDb()
      .select()
      .from(runs)
      .where(and(eq(runs.conversationId, main.id), sql`${runs.input}->>'reason' = 'continue'`))
      .orderBy(sql`${runs.createdAt} desc`)
      .limit(1);
    expect(woken!.input).toMatchObject({ note: expect.stringContaining('unknown whether it took effect') });
    expect(await jobOf(again!.id)).toMatchObject({ status: 'succeeded', attempts: 2 });

    await Promise.all([b.engine.shutdown(), c.engine.shutdown()]);
  }, 30_000);
});
