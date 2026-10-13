import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getDb, messages, notifications, runs, runSteps } from '@greenhouse/db';
import { createTestApp } from '../../testing.js';
import { defineTool } from '../tools/define.js';
import { gate, lastUserText, scriptedModel, systemText, text, toolCall } from './model.js';

function testTools(log: string[], flaky: { failures: number }) {
  return [
    defineTool({
      name: 'secret_read',
      description: 'Read private data.',
      input: z.object({}),
      risk: 'read',
      private: true,
      async execute() {
        log.push('secret_read');
        return { secret: 'the plan' };
      },
    }),
    defineTool({
      name: 'web_peek',
      description: 'Look at the web.',
      input: z.object({ q: z.string() }),
      risk: 'read',
      outbound: true,
      async execute(args) {
        log.push(`web_peek:${args.q}`);
        return { ok: true };
      },
    }),
    defineTool({
      name: 'lookup',
      description: 'Look a fact up.',
      input: z.object({ q: z.string() }),
      risk: 'read',
      async execute(args) {
        log.push(`lookup:${args.q}`);
        if (flaky.failures > 0) {
          flaky.failures -= 1;
          throw new Error('upstream down');
        }
        return { fact: `about ${args.q}` };
      },
    }),
    defineTool({
      name: 'note_write',
      description: 'Write a note.',
      input: z.object({ text: z.string() }),
      risk: 'write',
      async execute() {
        log.push('note_write');
        return { written: true };
      },
    }),
  ];
}

async function setup(scripts: Parameters<typeof scriptedModel>[0], flaky = { failures: 0 }) {
  const log: string[] = [];
  const model = scriptedModel(scripts);
  const app = createTestApp({}, { languageModel: model.languageModel, tools: testTools(log, flaky) });
  const lin = await app.member();
  const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
  const agent = (await app.call('GET', '/api/agents/main', { token: lin.token })).body;
  const start = (title: string, brief: string) =>
    app.services.engine.background.start({
      agentId: agent.id,
      ownerId: lin.id,
      requestedBy: lin.id,
      title,
      brief,
      source: 'conversation',
      sourceId: main.id,
      conversationId: main.id,
    });
  return { ...app, model, lin, main, agent, log, start };
}

describe('background runs', () => {
  it('start only from an approved proposal, run read-only, and report back', async () => {
    const { call, services, model, lin, main, log } = await setup([
      toolCall('run_start', { title: 'Market scan', brief: 'Find the three biggest competitors.' }),
      text('I proposed a background run.'),
      toolCall('lookup', { q: 'competitors' }),
      text('The three biggest are A, B and C.'),
    ]);
    await call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'scan the market' },
    });
    await services.engine.idle();
    expect((await call('GET', '/api/runs', { token: lin.token })).body.items).toEqual([]);
    const card = (await call('GET', '/api/requests', { token: lin.token })).body.items[0];
    expect(card).toMatchObject({
      kind: 'proposal',
      subject: 'run_start',
      title: 'Greeny 想开始一个后台运行：Market scan',
    });

    await call('POST', `/api/requests/${card.id}/approve`, { token: lin.token });
    await services.engine.idle();
    const list = await call('GET', '/api/runs', { token: lin.token });
    expect(list.body.items).toEqual([
      expect.objectContaining({ title: 'Market scan', status: 'succeeded', source: 'conversation' }),
    ]);
    const detail = await call('GET', `/api/runs/${list.body.items[0].id}`, { token: lin.token });
    expect(detail.body).toMatchObject({
      brief: 'Find the three biggest competitors.',
      output: 'The three biggest are A, B and C.',
    });
    expect(detail.body.steps).toEqual([expect.objectContaining({ tool: 'lookup', status: 'succeeded' })]);
    expect(detail.body.events.map((event: { type: string }) => event.type)).toEqual([
      'queued',
      'started',
      'step',
      'step',
      'succeeded',
    ]);
    expect(log).toEqual(['lookup:competitors']);

    // The run saw its brief and the Agent's rules for unwatched work, not the conversation.
    const prompt = model.prompts[2];
    expect(systemText(prompt)).toContain('You are working in the background');
    expect(lastUserText(prompt)).toContain('Find the three biggest competitors.');
    expect(JSON.stringify(prompt)).not.toContain('scan the market');

    const transcript = await getDb().select().from(messages).where(eq(messages.conversationId, main.id));
    const report = transcript.find((m) => m.runId === list.body.items[0].id);
    expect(report).toMatchObject({ role: 'assistant', content: 'The three biggest are A, B and C.' });
    expect(report!.blocks).toEqual([expect.objectContaining({ type: 'run', status: 'succeeded' })]);
    const [done] = await getDb()
      .select()
      .from(notifications)
      .where(and(eq(notifications.memberId, lin.id), eq(notifications.kind, 'run_done')));
    expect(done!.title).toBe('后台运行完成：Market scan');
  });

  it('cannot write, and cannot reach the web after reading private data', async () => {
    const { services, model, start, log } = await setup([
      toolCall('note_write', { text: 'x' }),
      toolCall('secret_read', {}),
      toolCall('web_peek', { q: 'the plan' }),
      text('Done what I could.'),
    ]);
    const run = await start('Mixed', 'Read the plan and look it up.');
    await services.engine.idle();
    // Write tools and turn-only tools are not offered to a background run at all.
    expect(model.tools[0]).toEqual(expect.arrayContaining(['secret_read', 'web_peek', 'lookup']));
    expect(model.tools[0]).not.toContain('note_write');
    expect(model.tools[0]).not.toContain('ask_user');
    expect(model.tools[0]).not.toContain('memory');
    const steps = await getDb().select().from(runSteps).where(eq(runSteps.runId, run.id));
    expect(steps.map((step) => [step.toolName, step.status])).toEqual([['secret_read', 'succeeded']]);
    expect(log).toEqual(['secret_read']);
    const [finished] = await getDb().select().from(runs).where(eq(runs.id, run.id));
    expect(finished!.status).toBe('succeeded');
  });

  it('stops on request and says so in the conversation', async () => {
    const hold = gate();
    const { call, services, lin, start } = await setup([{ parts: text('never'), gate: hold.promise }]);
    const run = await start('Long one', 'Take your time.');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const canceled = await call('POST', `/api/runs/${run.id}/cancel`, { token: lin.token });
    expect(canceled.status).toBe(200);
    await services.engine.idle();
    const [row] = await getDb().select().from(runs).where(eq(runs.id, run.id));
    expect(row!.status).toBe('canceled');
    const [line] = await getDb().select().from(messages).where(eq(messages.runId, run.id));
    expect(line).toMatchObject({ role: 'event', content: '已停止后台运行「Long one」。' });
    expect((await call('POST', `/api/runs/${run.id}/cancel`, { token: lin.token })).body.error.code).toBe(
      'run_finished',
    );
  });

  it('retries a failed run and reuses the steps that already succeeded', async () => {
    const flaky = { failures: 0 };
    const { call, services, lin, start, log } = await setup(
      [
        toolCall('lookup', { q: 'alpha' }, 'c1'),
        toolCall('lookup', { q: 'beta' }, 'c2'),
        text('first attempt'),
        toolCall('lookup', { q: 'alpha' }, 'c3'),
        toolCall('lookup', { q: 'beta' }, 'c4'),
        text('Both found.'),
      ],
      flaky,
    );
    const run = await start('Two lookups', 'Look up alpha and beta.');
    // Make the second lookup fail on the first attempt, and the model give up.
    flaky.failures = 0;
    await services.engine.idle();
    await getDb().update(runs).set({ status: 'failed', errorCode: 'run_failed' }).where(eq(runs.id, run.id));
    await getDb()
      .update(runSteps)
      .set({ status: 'failed' })
      .where(and(eq(runSteps.runId, run.id), eq(runSteps.toolName, 'lookup')));
    const alpha = (await getDb().select().from(runSteps).where(eq(runSteps.runId, run.id))).find(
      (step) => (step.input as { q: string }).q === 'alpha',
    );
    await getDb().update(runSteps).set({ status: 'succeeded' }).where(eq(runSteps.id, alpha!.id));
    log.length = 0;

    const retried = await call('POST', `/api/runs/${run.id}/retry`, { token: lin.token });
    expect(retried.status).toBe(200);
    await services.engine.idle();
    const [row] = await getDb().select().from(runs).where(eq(runs.id, run.id));
    expect(row).toMatchObject({ status: 'succeeded', attempt: 2 });
    // alpha came from the record, beta ran again.
    expect(log).toEqual(['lookup:beta']);
    expect((await call('POST', `/api/runs/${run.id}/retry`, { token: lin.token })).body.error.code).toBe(
      'run_not_retryable',
    );
  });

  it('keeps runs private and puts runs of a dead process back in the queue', async () => {
    const { call, services, lin, member, start } = await setup([text('Recovered.')]);
    const run = await start('Recover me', 'Anything.');
    await services.engine.idle();
    const chen = await member();
    expect((await call('GET', `/api/runs/${run.id}`, { token: chen.token })).status).toBe(404);
    expect((await call('GET', '/api/runs', { token: chen.token })).body.items).toEqual([]);

    // Pretend another process took it and died.
    await getDb()
      .update(runs)
      .set({ status: 'running', leaseOwner: 'api-dead', leaseExpiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(runs.id, run.id));
    await services.engine.sweep();
    await services.engine.idle();
    const [row] = await getDb().select().from(runs).where(eq(runs.id, run.id));
    expect(row).toMatchObject({ status: 'succeeded', attempt: 2 });
    const detail = await call('GET', `/api/runs/${run.id}`, { token: lin.token });
    expect(detail.body.events.map((event: { type: string }) => event.type)).toContain('requeued');
  });
});
