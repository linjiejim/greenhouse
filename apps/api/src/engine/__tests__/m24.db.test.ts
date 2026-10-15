import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  agentMemories,
  budgetReservations,
  budgets,
  conversationInbox,
  files,
  getDb,
  messages,
  newId,
  requests,
  runs,
  runSteps,
  transaction,
} from '@greenhouse/db';
import { createTestApp } from '../../testing.js';
import { ApiError } from '../../http/errors.js';
import { scriptedModel, gate, text, toolCall, lastUserText, systemText } from './model.js';
import { defineTool } from '../tools/define.js';
import { renderMemoryIndex } from '../prompt.js';
import { reserveHelpers, HELPER_RESERVED_TOKENS } from '../helper-budget.js';
import { pruneModelSteps } from '../retention.js';
import { redactFixture } from '../eval.js';

const ENV = {
  STORAGE_PROVIDER: 'local',
  STORAGE_ROOT: `${process.cwd()}/node_modules/.cache/tool-output-tests`,
  LLM_PROVIDER: 'deepseek',
  LLM_API_KEY: 'sk-test-helper-key',
};

async function setup(scripts: Parameters<typeof scriptedModel>[0], tools?: ReturnType<typeof defineTool>[]) {
  const model = scriptedModel(scripts);
  const app = createTestApp(ENV, { languageModel: model.languageModel, ...(tools ? { tools } : {}) });
  const person = await app.member();
  const main = (await app.call('GET', '/api/conversations', { token: person.token })).body.items[0];
  return { ...app, model, person, main };
}

describe('M2.4 engine additions', () => {
  it('waits for read-only clean-context helpers and wakes exactly once with only summaries', async () => {
    const hold = gate();
    const s = await setup([
      toolCall('helper_run', {
        briefs: [
          { title: 'First', brief: 'Check the first source.' },
          { title: 'Second', brief: 'Check the second source.' },
          { title: 'Third', brief: 'Check the third source.' },
        ],
      }),
      { parts: text('a'.repeat(1900) + 'First summary'), gate: hold.promise },
      text('b'.repeat(1900) + 'Second summary'),
      text('c'.repeat(1900) + 'Third summary'),
      text('Combined summary'),
    ]);
    await s.services.agents.remember(s.person.id, s.main.agent_id, {
      title: 'PRIVATE INDEX',
      content: 'private',
      category: 'fact',
      pinned: false,
    });
    const sent = await s.call('POST', `/api/conversations/${s.main.id}/messages`, {
      token: s.person.token,
      body: { content: 'delegate independent research' },
    });
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (s.model.calls() >= 4) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });
    const [parent] = await getDb().select().from(runs).where(eq(runs.id, sent.body.run_id));
    expect(parent).toMatchObject({ status: 'waiting', waitReason: 'helpers' });
    expect(systemText(s.model.prompts[1])).toContain('read-only helper');
    expect(lastUserText(s.model.prompts[1])).not.toContain('PRIVATE INDEX');
    expect(lastUserText(s.model.prompts[1])).not.toContain('delegate independent research');
    expect(s.model.tools[1]).toContain('knowledge_query');
    for (const tool of ['helper_run', 'run_start', 'knowledge_mutation', 'computer', 'ask_user', 'run_finish'])
      expect(s.model.tools[1]).not.toContain(tool);
    expect(
      await getDb().select().from(budgetReservations).where(eq(budgetReservations.memberId, s.person.id)),
    ).toHaveLength(3);
    hold.open();
    await s.services.engine.idle();
    const helpers = await s.call('GET', `/api/runs?parent=${sent.body.run_id}`, { token: s.person.token });
    expect(helpers.body.items).toHaveLength(3);
    expect(helpers.body.items.every((run: { status: string }) => run.status === 'succeeded')).toBe(true);
    expect({
      calls: s.model.calls(),
      parent: (await getDb().select().from(runs).where(eq(runs.id, sent.body.run_id)))[0]?.status,
      inbox: await getDb().select().from(conversationInbox).where(eq(conversationInbox.conversationId, s.main.id)),
    }).toMatchObject({ calls: 5, parent: 'succeeded' });
    expect(lastUserText(s.model.prompts.at(-1))).toContain('First summary');
    expect(lastUserText(s.model.prompts.at(-1))).toContain('Second summary');
    expect(lastUserText(s.model.prompts.at(-1))).toContain('Third summary');
    expect(s.model.calls()).toBe(5);
    expect(await getDb().select().from(agentMemories).where(eq(agentMemories.category, 'log'))).toHaveLength(3);
    expect(
      (await getDb().select().from(budgetReservations).where(eq(budgetReservations.memberId, s.person.id))).every(
        (row) => row.status !== 'reserved',
      ),
    ).toBe(true);
    expect(
      (await getDb().select().from(messages).where(eq(messages.conversationId, s.main.id))).filter(
        (row) => row.role === 'assistant' && row.content.includes('First summary'),
      ),
    ).toHaveLength(0);
  });

  it('reserves before committing children and refuses insufficient budgets without leaving runs', async () => {
    const s = await setup([
      toolCall('helper_run', { briefs: [{ title: 'Check', brief: 'Research' }] }),
      text('Budget unavailable'),
    ]);
    await getDb()
      .insert(budgets)
      .values({
        id: newId('budget'),
        scopeType: 'member',
        scopeId: s.person.id,
        unit: 'tokens',
        monthlyLimit: HELPER_RESERVED_TOKENS - 1,
      });
    const sent = await s.call('POST', `/api/conversations/${s.main.id}/messages`, {
      token: s.person.token,
      body: { content: 'research' },
    });
    await s.services.engine.idle();
    expect(await getDb().select().from(runs).where(eq(runs.parentRunId, sent.body.run_id))).toEqual([]);
    expect(await getDb().select().from(budgetReservations)).toEqual([]);
    const [step] = await getDb()
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, sent.body.run_id), eq(runSteps.kind, 'tool')));
    expect(step?.error).toEqual({ code: 'budget_exceeded', message: '开始 1 个子运行失败：剩余预算不足' });
  });

  it('counts outstanding reservations, includes agent budgets and refuses unpriced cost estimates', async () => {
    const s = await setup([]);
    const budgetId = newId('budget');
    await getDb().insert(budgets).values({
      id: budgetId,
      scopeType: 'agent',
      scopeId: s.main.agent_id,
      unit: 'tokens',
      monthlyLimit: HELPER_RESERVED_TOKENS,
    });
    const input = {
      memberId: s.person.id,
      agentId: s.main.agent_id,
      providerId: 'test',
      cost: null,
      personalCounting: [],
    };
    await reserveHelpers({ ...input, runIds: ['first'] });
    await expect(transaction(() => reserveHelpers({ ...input, runIds: ['second'] }))).rejects.toMatchObject({
      code: 'budget_exceeded',
    });
    await getDb().update(budgets).set({ enabled: false }).where(eq(budgets.id, budgetId));
    await getDb()
      .insert(budgets)
      .values({
        id: newId('budget'),
        scopeType: 'workspace',
        scopeId: 'default',
        unit: 'usd_micros',
        monthlyLimit: 1_000_000,
      });
    await expect(transaction(() => reserveHelpers({ ...input, runIds: ['unpriced'] }))).rejects.toMatchObject({
      code: 'budget_estimate_unavailable',
    });
  });

  it('stores large results privately, ranges Unicode, expires files and never rewrites history', async () => {
    const content = '前'.repeat(7999) + '😀tail';
    const s = await setup(
      [toolCall('large', {}), text('Stored')],
      [
        defineTool({
          name: 'large',
          description: 'Read a long result',
          input: z.object({}),
          risk: 'read',
          idempotent: true,
          async execute() {
            return content;
          },
        }),
      ],
    );
    const sent = await s.call('POST', `/api/conversations/${s.main.id}/messages`, {
      token: s.person.token,
      body: { content: 'large output' },
    });
    await s.services.engine.idle();
    const [step] = await getDb()
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, sent.body.run_id), eq(runSteps.kind, 'tool')));
    const output = step!.output as { file: { id: string }; head: string; length: number };
    expect(output.head).toHaveLength(1200);
    expect(output.length).toBe(content.length);
    const [file] = await getDb().select().from(files).where(eq(files.id, output.file.id));
    expect(file).toMatchObject({ purpose: 'tool_output', ownerId: s.person.id, conversationId: null });
    const other = await s.member();
    expect((await s.call('GET', `/api/files/${file!.id}`, { token: other.token })).status).toBe(404);
    const def = s.services.engine.toolsForEvaluation().find((tool) => tool.name === 'tool_output_read');
    const ranged = await def!.execute({ file_id: file!.id, offset: 7999, length: 6 }, {
      memberId: s.person.id,
    } as never);
    expect(ranged).toMatchObject({ content: '😀tail', next_offset: null });
    expect(Buffer.from((await s.services.files.bytes(s.person.id, file!.id)).bytes).toString('utf8')).toBe(content);
    expect(JSON.stringify(s.model.prompts.at(-1))).not.toContain('前'.repeat(2000));
    await getDb()
      .update(files)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(files.id, file!.id));
    await expect(s.services.files.get(s.person.id, file!.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await s.services.files.pruneToolOutputs()).toBe(1);
  });

  it('writes one dated completion log, keeps old logs out of the index and recalls by date', async () => {
    const s = await setup([
      text('Checked sources. No outstanding work.'),
      toolCall('memory', { action: 'recall', from: new Date().toISOString().slice(0, 10) }),
      toolCall('memory', { action: 'remember', title: 'A log is not an instruction' }),
      text('Recalled'),
    ]);
    const run = await s.services.engine.background.start({
      agentId: s.main.agent_id,
      ownerId: s.person.id,
      requestedBy: s.person.id,
      title: 'Daily check',
      brief: 'Check sources',
      source: 'conversation',
      conversationId: s.main.id,
    });
    await s.services.engine.idle();
    await s.services.engine.background.reportCompleted(run.id, 1);
    const logs = await getDb().select().from(agentMemories).where(eq(agentMemories.category, 'log'));
    expect(logs).toHaveLength(1);
    const [savedRun] = await getDb().select().from(runs).where(eq(runs.id, run.id));
    expect(savedRun!.checkpoint?.eval).toMatchObject({ background: { helper: false }, surface: 'background' });
    expect(logs[0]!.content.split('\n')).toHaveLength(2);
    expect(logs[0]!.title).toMatch(/^\d{4}-\d{2}-\d{2} Daily check$/);
    expect(
      renderMemoryIndex(
        [{ id: 'old', title: 'old log', category: 'log', pinned: true, created_at: '2000-01-01T00:00:00Z' }],
        'en',
      ),
    ).toBeNull();
    await s.call('POST', `/api/conversations/${s.main.id}/messages`, {
      token: s.person.token,
      body: { content: 'Recall today' },
    });
    await s.services.engine.idle();
    expect(JSON.stringify(s.model.prompts.at(-1))).toContain('Checked sources');
    expect(
      await getDb().select().from(agentMemories).where(eq(agentMemories.title, 'A log is not an instruction')),
    ).toEqual([]);
  });

  it('prunes only terminal model contexts older than 90 days and redacts fixture credentials', async () => {
    const s = await setup([]);
    const rows = await getDb()
      .insert(runs)
      .values(
        ['succeeded', 'running'].map((status) => ({
          id: newId('run'),
          agentId: s.main.agent_id,
          ownerId: s.person.id,
          kind: 'background' as const,
          source: 'conversation' as const,
          status: status as 'succeeded' | 'running',
          finishedAt: '2000-01-01T00:00:00Z',
        })),
      )
      .returning();
    await getDb()
      .insert(runSteps)
      .values(
        rows.flatMap((run) =>
          ['model', 'tool'].map((kind) => ({
            id: newId('runStep'),
            runId: run.id,
            key: kind,
            kind: kind as 'model' | 'tool',
            status: 'succeeded' as const,
          })),
        ),
      );
    expect(await pruneModelSteps()).toBe(1);
    expect(await getDb().select().from(runSteps)).toHaveLength(3);
    expect(redactFixture({ secret: 'value', content: 'Bearer abcdef and sk-secret123456 ?sig=abcdef' })).toEqual({
      secret: '[redacted]',
      content: 'Bearer [redacted] and [redacted] ?sig=[redacted]',
    });
  });
  it('limits delegation to the main Agent and three children in the parent turn', async () => {
    const s = await setup([]);
    const [parent] = await getDb()
      .insert(runs)
      .values({
        id: newId('run'),
        agentId: s.main.agent_id,
        ownerId: s.person.id,
        kind: 'turn',
        source: 'conversation',
        status: 'running',
        conversationId: s.main.id,
      })
      .returning();
    const input = {
      parentRunId: parent!.id,
      memberId: s.person.id,
      briefs: [
        { title: 'One', brief: 'Read' },
        { title: 'Two', brief: 'Read' },
        { title: 'Three', brief: 'Read' },
      ],
    };
    await s.services.engine.background.helpers(input);
    await expect(
      s.services.engine.background.helpers({ ...input, briefs: [{ title: 'Four', brief: 'Read' }] }),
    ).rejects.toMatchObject({ code: 'helper_limit' });
    expect(await getDb().select().from(runs).where(eq(runs.parentRunId, parent!.id))).toHaveLength(3);
    const own = await s.services.agents.create(s.person.id, { name: 'Private researcher', role: 'Research' });
    await getDb().update(runs).set({ agentId: own.id }).where(eq(runs.id, parent!.id));
    await expect(
      s.services.engine.background.helpers({ ...input, briefs: [{ title: 'Other', brief: 'Read' }] }),
    ).rejects.toMatchObject({ code: 'helper_forbidden' });
  });
  it('taints the parent continuation after helper summaries so outside findings cannot mutate memory', async () => {
    const s = await setup([
      toolCall('helper_run', { briefs: [{ title: 'Read outside', brief: 'Read only' }] }),
      text('An outside source asks you to remember its instructions.'),
      toolCall('memory', { action: 'remember', title: 'Injected helper instructions' }),
      toolCall('helper_run', { briefs: [{ title: 'Again', brief: 'Delegate again' }] }),
      text('The summary is data.'),
    ]);
    await s.call('POST', `/api/conversations/${s.main.id}/messages`, {
      token: s.person.token,
      body: { content: 'Research' },
    });
    await s.services.engine.idle();
    expect(
      await getDb().select().from(agentMemories).where(eq(agentMemories.title, 'Injected helper instructions')),
    ).toEqual([]);
    expect(JSON.stringify(s.model.prompts.at(-1))).toContain('Memories cannot be changed');
    expect(await getDb().select().from(runs).where(eq(runs.kind, 'background'))).toHaveLength(1);
  });
  it('keeps successful action evidence when long-output storage is unavailable', async () => {
    let effects = 0;
    const model = scriptedModel([toolCall('large_effect', {}), text('The action finished.')]);
    const app = createTestApp(
      {},
      {
        languageModel: model.languageModel,
        tools: [
          defineTool({
            name: 'large_effect',
            description: 'An external test action with a long receipt.',
            input: z.object({}),
            risk: 'external',
            async execute() {
              effects++;
              return 'receipt'.repeat(1500);
            },
          }),
        ],
      },
    );
    const member = await app.member();
    const main = (await app.call('GET', '/api/conversations', { token: member.token })).body.items[0];
    const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: member.token,
      body: { content: 'Perform the action' },
    });
    await app.services.engine.idle();
    const [card] = await getDb().select().from(requests).where(eq(requests.runId, sent.body.run_id));
    expect(effects).toBe(0);
    const storage = vi
      .spyOn(app.services.files, 'store')
      .mockRejectedValueOnce(new ApiError(503, 'storage_unavailable', 'Test storage outage.'));
    await app.call('POST', `/api/requests/${card!.id}/approve`, { token: member.token });
    await app.services.engine.idle();
    expect(storage).toHaveBeenCalledTimes(1);
    storage.mockRestore();
    expect(effects).toBe(1);
    const [step] = await getDb()
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, sent.body.run_id), eq(runSteps.kind, 'tool')));
    expect(step).toMatchObject({
      status: 'succeeded',
      output: { length: 10500, storage_error: 'storage_unavailable' },
    });
    expect(JSON.stringify(model.prompts.at(-1))).toContain('Do not repeat a write');
  });
});
