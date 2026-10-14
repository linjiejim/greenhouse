import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, expect, it, vi } from 'vitest';
import { agentMemories, conversationMembers, getDb, jobs, members, messages, runs, runSteps } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/testing';
import { createTestApp, createTestServices } from '../../testing.js';
import { gate, scriptedModel, text, textThenTool } from './model.js';
import { defineTool } from '../tools/define.js';
import { z } from 'zod';

const created: string[] = [];
afterAll(async () => {
  await getDb().delete(runs).where(inArray(runs.ownerId, created));
  await getDb().delete(members).where(inArray(members.id, created));
  await getDb()
    .delete(jobs)
    .where(sql`${jobs.kind} in ('conversation_digest', 'engine_retention')`);
});

it('resumes a killed process in one reply and only one of two replicas owns recovery', async () => {
  const model = scriptedModel([text('Alpha is 42.')]);
  const a = createTestApp({ GREENHOUSE_ROLE: 'api' }, { languageModel: model.languageModel });
  const person = await a.member();
  created.push(person.id);
  const main = await a.services.conversations.ensureMain(person.id);
  const child = fork(
    fileURLToPath(new URL('./fixtures/turn-process.mts', import.meta.url)),
    [TEST_DATABASE_URL, person.id, main.id],
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  try {
    const received = await Promise.race([
      once(child, 'message').then(([value]) => value as { runId: string }),
      once(child, 'exit').then(() => {
        throw new Error('Child exited before checkpoint');
      }),
    ]);
    const [before] = await getDb()
      .select()
      .from(messages)
      .where(and(eq(messages.runId, received.runId), eq(messages.role, 'assistant')));
    expect(before!.content).toBe('I checked alpha. ');
    child.kill('SIGKILL');
    await once(child, 'exit');
    await getDb()
      .update(runs)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(runs.id, received.runId));
    // A partial next-step flush is discarded; only the completed prefix survives.
    await getDb()
      .update(messages)
      .set({ content: before!.content + 'unfinished fragment' })
      .where(eq(messages.id, before!.id));
    const b = createTestServices({ GREENHOUSE_ROLE: 'api' }, { languageModel: model.languageModel });
    await Promise.all([a.services.engine.sweep(), b.engine.sweep()]);
    await Promise.all([a.services.engine.idle(), b.engine.idle()]);
    const [done] = await getDb().select().from(runs).where(eq(runs.id, received.runId));
    expect(done).toMatchObject({ status: 'succeeded', attempt: 2 });
    const replies = await getDb()
      .select()
      .from(messages)
      .where(and(eq(messages.runId, received.runId), eq(messages.role, 'assistant')));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ id: before!.id, status: 'complete', content: 'I checked alpha. Alpha is 42.' });
    expect(replies[0]!.citations).toContainEqual({
      kind: 'web',
      url: 'https://example.test/alpha',
      title: 'Alpha evidence',
    });
    expect(replies[0]!.steps).toEqual([expect.objectContaining({ tool: 'lookup', status: 'done' })]);
    expect(await getDb().select().from(agentMemories).where(eq(agentMemories.memberId, person.id))).toHaveLength(1);
    expect(model.calls()).toBe(1);
    expect(JSON.stringify(model.prompts[0])).toContain('alpha is 42');
    expect(done!.checkpoint?.tainted).toBe(true);
    const steps = await getDb()
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, done!.id), eq(runSteps.kind, 'model')))
      .orderBy(runSteps.key);
    expect(steps.map((step) => [step.key, step.attempt])).toEqual([
      ['model:1', 1],
      ['model:2', 2],
    ]);
    await b.engine.shutdown();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await a.services.engine.shutdown({ graceMs: 0 });
  }
}, 30_000);

it('recovers an interjected reply after a crash and admits another interjection', async () => {
  const hold = gate();
  const model = scriptedModel([
    {
      parts: textThenTool('Resumed prefix. ', 'knowledge_query', { action: 'search', query: 'no match' }),
      gate: hold.promise,
    },
    text('Final with both details.'),
  ]);
  const a = createTestApp({ GREENHOUSE_ROLE: 'api' }, { languageModel: model.languageModel });
  const person = await a.member();
  created.push(person.id);
  const main = await a.services.conversations.ensureMain(person.id);
  const child = fork(
    fileURLToPath(new URL('./fixtures/turn-process.mts', import.meta.url)),
    [TEST_DATABASE_URL, person.id, main.id, 'interjection'],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  try {
    const [started] = (await once(child, 'message')) as [{ runId: string }];
    const first = await a.services.engine.post(person.id, main.id, {
      content: 'first-detail',
      mentions: [],
      attachments: [],
    });
    const checkpoint = once(child, 'message');
    child.send('release');
    await checkpoint;
    const before = await getDb()
      .select()
      .from(messages)
      .where(and(eq(messages.runId, started.runId), eq(messages.role, 'assistant')))
      .orderBy(messages.seq);
    expect(before).toHaveLength(2);
    expect(before[0]).toMatchObject({ status: 'complete', content: 'I checked alpha. ' });
    expect(before[1]).toMatchObject({ status: 'streaming', content: 'With extra detail. ' });
    const [firstRow] = await getDb().select().from(messages).where(eq(messages.id, first.message.id));
    expect(firstRow!.event).toMatchObject({ state: 'incorporated', run_id: started.runId });
    child.kill('SIGKILL');
    await once(child, 'exit');
    await getDb()
      .update(runs)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(runs.id, started.runId));
    await getDb()
      .update(messages)
      .set({ content: before[1]!.content + 'unfinished fragment' })
      .where(eq(messages.id, before[1]!.id));
    await a.services.engine.sweep();
    await vi.waitFor(() => expect(model.calls()).toBe(1));
    const second = await a.services.engine.post(person.id, main.id, {
      content: 'second-detail',
      mentions: [],
      attachments: [],
    });
    hold.open();
    await a.services.engine.idle();
    const [done] = await getDb().select().from(runs).where(eq(runs.id, started.runId));
    expect(done).toMatchObject({ status: 'succeeded', attempt: 2, checkpoint: { tainted: true } });
    const replies = await getDb()
      .select()
      .from(messages)
      .where(and(eq(messages.runId, started.runId), eq(messages.role, 'assistant')))
      .orderBy(messages.seq);
    expect(replies).toHaveLength(3);
    expect(replies[0]).toMatchObject({ id: before[0]!.id, content: 'I checked alpha. ', status: 'complete' });
    expect(replies[1]).toMatchObject({
      id: before[1]!.id,
      content: 'With extra detail. Resumed prefix. ',
      status: 'complete',
    });
    expect(replies[2]).toMatchObject({ content: 'Final with both details.', status: 'complete' });
    expect(replies[0]!.steps.map((step) => step.tool)).toEqual(['lookup']);
    expect(replies[1]!.steps.map((step) => step.tool)).toEqual(['lookup', 'knowledge_query']);
    expect(replies[2]!.steps).toEqual([]);
    expect(replies[2]!.citations).toContainEqual({
      kind: 'web',
      url: 'https://example.test/alpha',
      title: 'Alpha evidence',
    });
    expect(await getDb().select().from(agentMemories).where(eq(agentMemories.memberId, person.id))).toHaveLength(2);
    const additions = await getDb()
      .select()
      .from(messages)
      .where(inArray(messages.id, [first.message.id, second.message.id]))
      .orderBy(messages.seq);
    expect(additions[0]).toMatchObject({ seq: firstRow!.seq, event: { state: 'incorporated', run_id: started.runId } });
    expect(additions[1]!.event).toMatchObject({ state: 'incorporated', run_id: started.runId });
    expect(JSON.stringify(model.prompts[0]).match(/first-detail/g)).toHaveLength(1);
    expect(JSON.stringify(model.prompts[1]).match(/first-detail/g)).toHaveLength(1);
    expect(JSON.stringify(model.prompts[1]).match(/second-detail/g)).toHaveLength(1);
    const steps = await getDb()
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, started.runId), eq(runSteps.kind, 'model')))
      .orderBy(runSteps.key);
    expect(steps.map((step) => [step.key, step.attempt])).toEqual([
      ['model:1', 1],
      ['model:2', 1],
      ['model:3', 1],
      ['model:4', 2],
      ['model:5', 2],
      ['model:6', 2],
    ]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await a.services.engine.shutdown({ graceMs: 0 });
  }
}, 30_000);

it.each(['old', 'left', 'incomplete', 'stopped'] as const)(
  'ends an ineligible %s turn as interrupted',
  async (reason) => {
    const hold = gate();
    const model = scriptedModel([
      textThenTool('Checked. ', 'lookup', { q: 'a' }),
      { parts: text('unfinished'), gate: hold.promise },
    ]);
    const a = createTestApp(
      { GREENHOUSE_ROLE: 'api' },
      {
        languageModel: model.languageModel,
        tools: [
          defineTool({
            name: 'lookup',
            description: 'Read a fact.',
            risk: 'read',
            input: z.object({ q: z.string() }),
            async execute() {
              return { fact: 42 };
            },
          }),
        ],
      },
    );
    const person = await a.member();
    created.push(person.id);
    const main = await a.services.conversations.ensureMain(person.id);
    const sent = await a.services.engine.post(person.id, main.id, { content: 'Check', mentions: [], attachments: [] });
    for (let wait = 0; wait < 200 && model.calls() < 2; wait++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(model.calls()).toBe(2);
    await a.services.engine.shutdown({ graceMs: 0 });
    if (reason === 'old')
      await getDb()
        .update(runs)
        .set({ leaseExpiresAt: sql`now() - interval '11 minutes'` })
        .where(eq(runs.id, sent.run_id!));
    if (reason === 'left')
      await getDb()
        .delete(conversationMembers)
        .where(and(eq(conversationMembers.conversationId, main.id), eq(conversationMembers.memberId, person.id)));
    if (reason === 'incomplete')
      await getDb()
        .insert(runSteps)
        .values({
          id: 'rst_incomplete_' + person.id,
          runId: sent.run_id!,
          key: 'unrecorded',
          kind: 'tool',
          status: 'running',
          toolName: 'lookup',
          startedAt: sql`now()`,
        });
    if (reason === 'stopped')
      await getDb().update(runs).set({ desiredState: 'cancel' }).where(eq(runs.id, sent.run_id!));
    const b = createTestServices({ GREENHOUSE_ROLE: 'api' }, { languageModel: model.languageModel });
    await b.engine.sweep();
    await b.engine.idle();
    const [done] = await getDb().select().from(runs).where(eq(runs.id, sent.run_id!));
    expect(done).toMatchObject({ status: 'failed', errorCode: 'interrupted' });
    expect(model.calls()).toBe(2);
    await b.engine.shutdown();
  },
  15_000,
);

it('drains a running reply and leaves later messages for another API process', async () => {
  const hold = gate();
  const model = scriptedModel([{ parts: text('Finished gracefully.'), gate: hold.promise }, text('Next reply.')]);
  const a = createTestApp({ GREENHOUSE_ROLE: 'api' }, { languageModel: model.languageModel });
  const person = await a.member();
  created.push(person.id);
  const main = await a.services.conversations.ensureMain(person.id);
  await a.services.engine.post(person.id, main.id, { content: 'First', mentions: [], attachments: [] });
  for (let wait = 0; wait < 100 && model.calls() < 1; wait++) await new Promise((resolve) => setTimeout(resolve, 10));
  a.services.engine.drain();
  const next = await a.services.engine.post(person.id, main.id, { content: 'Next', mentions: [], attachments: [] });
  expect(next.queued).toBe(true);
  const drained = a.services.engine.shutdown({ graceMs: 1000 });
  hold.open();
  await drained;
  expect(model.calls()).toBe(1);
  const b = createTestServices({ GREENHOUSE_ROLE: 'api' }, { languageModel: model.languageModel });
  await b.engine.sweep();
  await b.engine.idle();
  expect(model.calls()).toBe(2);
  await b.engine.shutdown();
});

it('API queues background work and worker queues foreground events', async () => {
  const model = scriptedModel([text('Background complete.'), text('Foreground complete.')]);
  const api = createTestApp({ GREENHOUSE_ROLE: 'api' }, { languageModel: model.languageModel });
  const person = await api.member();
  created.push(person.id);
  const main = await api.services.conversations.ensureMain(person.id);
  const run = await api.services.engine.background.start({
    agentId: main.agentId!,
    ownerId: person.id,
    requestedBy: person.id,
    title: 'Work',
    brief: 'Do work.',
    source: 'conversation',
    conversationId: main.id,
  });
  await api.services.engine.idle();
  expect(model.calls()).toBe(0);
  const worker = createTestServices({ GREENHOUSE_ROLE: 'worker' }, { languageModel: model.languageModel });
  await worker.engine.sweep();
  await worker.engine.idle();
  expect((await getDb().select().from(runs).where(eq(runs.id, run.id)))[0]!.status).toBe('succeeded');
  await worker.engine.deliver(main.id, {
    agentId: main.agentId!,
    memberId: person.id,
    note: 'Event',
    kind: 'event',
    dedupeKey: 'split:' + person.id,
  });
  await worker.engine.idle();
  expect(model.calls()).toBe(1);
  await api.services.engine.sweep();
  await api.services.engine.idle();
  expect(model.calls()).toBe(2);
  await worker.engine.shutdown();
  await api.services.engine.shutdown();
});

it('counts crashes separately from prior shutdown attempts', async () => {
  const model = scriptedModel([text('Recovered.')]);
  const app = createTestApp({ GREENHOUSE_ROLE: 'worker' }, { languageModel: model.languageModel });
  const person = await app.member();
  created.push(person.id);
  const main = await app.services.conversations.ensureMain(person.id);
  const run = await app.services.engine.background.create({
    agentId: main.agentId!,
    ownerId: person.id,
    requestedBy: person.id,
    title: 'Resume',
    brief: 'Finish',
    source: 'conversation',
    conversationId: main.id,
  });
  await getDb()
    .update(runs)
    .set({ status: 'running', attempt: 9, leaseOwner: 'dead', leaseExpiresAt: sql`now() - interval '1 second'` })
    .where(eq(runs.id, run.id));
  await app.services.engine.sweep();
  await app.services.engine.idle();
  const [done] = await getDb().select().from(runs).where(eq(runs.id, run.id));
  expect(done).toMatchObject({ status: 'succeeded', attempt: 10, checkpoint: { crashes: 1 } });
  await app.services.engine.shutdown();
});

it('finishes an already completed answer without another model call', async () => {
  const initial = scriptedModel([text('Complete answer.')]);
  const a = createTestApp({ GREENHOUSE_ROLE: 'api' }, { languageModel: initial.languageModel });
  const person = await a.member();
  created.push(person.id);
  const main = await a.services.conversations.ensureMain(person.id);
  const sent = await a.services.engine.post(person.id, main.id, { content: 'Answer', mentions: [], attachments: [] });
  await a.services.engine.idle();
  const [reply] = await getDb()
    .select()
    .from(messages)
    .where(and(eq(messages.runId, sent.run_id!), eq(messages.role, 'assistant')));
  await getDb().update(messages).set({ status: 'streaming' }).where(eq(messages.id, reply!.id));
  await getDb()
    .update(runs)
    .set({ status: 'running', leaseOwner: 'dead', leaseExpiresAt: sql`now() - interval '1 second'` })
    .where(eq(runs.id, sent.run_id!));
  const next = scriptedModel([]);
  const b = createTestServices({ GREENHOUSE_ROLE: 'api' }, { languageModel: next.languageModel });
  await b.engine.sweep();
  await b.engine.idle();
  expect(next.calls()).toBe(0);
  expect((await getDb().select().from(messages).where(eq(messages.id, reply!.id)))[0]).toMatchObject({
    status: 'complete',
    content: 'Complete answer.',
  });
  await a.services.engine.shutdown();
  await b.engine.shutdown();
});
