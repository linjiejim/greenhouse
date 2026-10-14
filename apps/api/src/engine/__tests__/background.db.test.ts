import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getDb, messages, newId, notifications, runs, runSteps } from '@greenhouse/db';
import { createTestApp } from '../../testing.js';
import { callKey } from '../tools/assemble.js';
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
      idempotent: true,
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
    // Offered to background runs, but with an effect outside: not idempotent.
    defineTool({
      name: 'ping_team',
      description: 'Ping the team.',
      input: z.object({ text: z.string() }),
      risk: 'read',
      async execute(args) {
        log.push(`ping_team:${args.text}`);
        return { pinged: true };
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
  /** A run back in the queue after its first attempt died in the middle of these calls. */
  const interrupted = async (calls: Array<{ tool: string; args: Record<string, unknown> }>) => {
    const [run] = await getDb()
      .insert(runs)
      .values({
        id: newId('run'),
        agentId: agent.id,
        ownerId: lin.id,
        requestedBy: lin.id,
        kind: 'background',
        source: 'conversation',
        sourceId: main.id,
        conversationId: main.id,
        title: 'Ping',
        brief: 'Ping the team about the standup.',
        status: 'queued',
        attempt: 1,
      })
      .returning();
    for (const [index, call] of calls.entries()) {
      await getDb()
        .insert(runSteps)
        .values({
          id: newId('runStep'),
          runId: run!.id,
          key: `dead_${index}`,
          attempt: 1,
          kind: 'tool',
          toolName: call.tool,
          risk: 'read',
          idempotencyKey: callKey(call.tool, call.args),
          status: 'running',
          input: call.args,
        });
    }
    return run!;
  };
  return { ...app, model, lin, main, agent, log, start, interrupted };
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

    const transcript = await getDb()
      .select()
      .from(messages)
      .where(eq(messages.conversationId, main.id))
      .orderBy(asc(messages.seq));
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
    expect(model.tools[0]).toContain('memory');
    const steps = await getDb()
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, run.id), eq(runSteps.kind, 'tool')));
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

  it('retries a failed run from the steps it recorded, without running them again', async () => {
    const { call, services, model, lin, start, log } = await setup([
      toolCall('lookup', { q: 'alpha' }, 'c1'),
      { parts: [], error: 'The model service is overloaded.' },
      toolCall('lookup', { q: 'beta' }, 'c2'),
      text('Both found.'),
    ]);
    const run = await start('Two lookups', 'Look up alpha and beta.');
    await services.engine.idle();
    const [failed] = await getDb().select().from(runs).where(eq(runs.id, run.id));
    expect(failed).toMatchObject({ status: 'failed', attempt: 1 });
    expect(log).toEqual(['lookup:alpha']);
    // The model step is kept as the run's context, never listed as something it did.
    const steps = await getDb().select().from(runSteps).where(eq(runSteps.runId, run.id));
    expect(steps.map((step) => [step.kind, step.key])).toEqual(
      expect.arrayContaining([
        ['tool', 'c1'],
        ['model', 'model:1'],
      ]),
    );
    expect((await call('GET', `/api/runs/${run.id}`, { token: lin.token })).body.steps).toEqual([
      expect.objectContaining({ tool: 'lookup', kind: 'tool', status: 'succeeded' }),
    ]);

    const retried = await call('POST', `/api/runs/${run.id}/retry`, { token: lin.token });
    expect(retried.status).toBe(200);
    await services.engine.idle();
    const [row] = await getDb().select().from(runs).where(eq(runs.id, run.id));
    expect(row).toMatchObject({ status: 'succeeded', attempt: 2, output: { text: 'Both found.' } });
    // The retry went on from alpha's result: alpha did not run again.
    expect(log).toEqual(['lookup:alpha', 'lookup:beta']);
    expect(JSON.stringify(model.prompts[2])).toContain('about alpha');
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

  it('marks what a dead process left running: a read failed, a call with effects is uncertain', async () => {
    const { call, services, lin, start } = await setup([text('Recovered.')]);
    const run = await start('Recover me', 'Anything.');
    await services.engine.idle();
    await getDb()
      .update(runs)
      .set({ status: 'running', leaseOwner: 'api-dead', leaseExpiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(runs.id, run.id));
    for (const [tool, args] of [
      ['ping_team', { text: 'standup' }],
      ['lookup', { q: 'standup' }],
    ] as const) {
      await getDb()
        .insert(runSteps)
        .values({
          id: newId('runStep'),
          runId: run.id,
          key: tool,
          attempt: 1,
          kind: 'tool',
          toolName: tool,
          risk: 'read',
          idempotencyKey: callKey(tool, args),
          status: 'running',
          input: args,
        });
    }
    await services.engine.background.sweep();
    await services.engine.idle();
    const detail = await call('GET', `/api/runs/${run.id}`, { token: lin.token });
    expect(detail.body.steps).toHaveLength(2);
    expect(detail.body.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: 'ping_team', status: 'uncertain' }),
        expect.objectContaining({
          tool: 'lookup',
          status: 'failed',
          error: expect.objectContaining({ code: 'interrupted' }),
        }),
      ]),
    );
  });

  it('never makes a call with effects again by itself when an earlier attempt left it unfinished', async () => {
    const { call, services, model, lin, log, interrupted } = await setup([
      toolCall('ping_team', { text: 'standup' }),
      toolCall('lookup', { q: 'standup' }, 'c2'),
      text('The standup ping may not have gone out: check the channel before sending it again.'),
    ]);
    const run = await interrupted([
      { tool: 'ping_team', args: { text: 'standup' } },
      { tool: 'lookup', args: { q: 'standup' } },
    ]);
    await services.engine.background.sweep();
    await services.engine.idle();
    // The ping is not sent again; the read simply runs again.
    expect(log).toEqual(['lookup:standup']);
    expect(JSON.stringify(model.prompts[1])).toContain('whether it took effect is unknown');
    const detail = await call('GET', `/api/runs/${run.id}`, { token: lin.token });
    expect(detail.body).toMatchObject({ status: 'succeeded', attempt: 2 });
    expect(detail.body.steps).toHaveLength(2);
    expect(detail.body.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: 'ping_team', status: 'uncertain', attempt: 2 }),
        expect.objectContaining({ tool: 'lookup', status: 'succeeded', attempt: 2 }),
      ]),
    );
  });

  it('makes the call once the Agent, told the outcome is unknown, makes it again', async () => {
    const { services, log, interrupted } = await setup([
      toolCall('ping_team', { text: 'standup' }),
      toolCall('lookup', { q: 'was the standup ping sent' }, 'c2'),
      toolCall('ping_team', { text: 'standup' }, 'c3'),
      text('It had not gone out; pinged the team now.'),
    ]);
    const run = await interrupted([{ tool: 'ping_team', args: { text: 'standup' } }]);
    await services.engine.background.sweep();
    await services.engine.idle();
    expect(log).toEqual(['lookup:was the standup ping sent', 'ping_team:standup']);
    const [ping] = await getDb()
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, run.id), eq(runSteps.toolName, 'ping_team')));
    expect(ping).toMatchObject({ status: 'succeeded', attempt: 2 });
  });
});
