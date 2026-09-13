/**
 * Node executor — prompt assembly, fenced-JSON output parsing, schema checks,
 * the one-shot repair retry, and session/row lifecycle. Fake db + stubbed
 * generate (same style as spawn-session.test.ts) — no Postgres, no LLM.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildNodePrompt, parseNodeOutput, checkOutputSchema, executeNode } from '../node-executor.js';
import { makeFakeWorkflowDb, makeRun, TEST_PROFILE } from './fake-db.js';
import type { WorkflowNode } from '@greenhouse/types/workflow';

const node: WorkflowNode = {
  id: 'research',
  agent: 'team',
  brief: {
    objective: '调研 LPH64 的目标市场',
    inputs: { task: '$run.input' },
    output_schema: { summary: 'string', score: 'number' },
    boundaries: '不要联系任何外部人员',
    end_on: '产出含 summary 与 score 的结构化结论',
  },
  role_addendum: '只输出中文。',
};

describe('buildNodePrompt', () => {
  it('renders the delegation contract: objective, inputs, boundaries, end_on, output schema', () => {
    const prompt = buildNodePrompt(node, { task: '写上市方案' });
    expect(prompt).toContain('调研 LPH64 的目标市场');
    expect(prompt).toContain('写上市方案');
    expect(prompt).toContain('不要联系任何外部人员');
    expect(prompt).toContain('summary');
    expect(prompt).toContain('```json');
  });

  it('appends reviewer feedback on returned attempts', () => {
    const prompt = buildNodePrompt(node, {}, '上一版缺少定价分析');
    expect(prompt).toContain('上一版缺少定价分析');
  });
});

describe('parseNodeOutput / checkOutputSchema', () => {
  it('extracts the last fenced JSON block', () => {
    const text = '分析如下……\n```json\n{"summary":"好","score":8}\n```\n完。';
    expect(parseNodeOutput(text)).toEqual({ summary: '好', score: 8 });
  });

  it('returns null when no JSON is present', () => {
    expect(parseNodeOutput('没有任何 JSON')).toBeNull();
  });

  it('type-checks against the simplified schema map', () => {
    expect(checkOutputSchema({ summary: 'ok', score: 3 }, { summary: 'string', score: 'number' })).toEqual([]);
    expect(checkOutputSchema({ summary: 42 }, { summary: 'string', score: 'number' }).join(' ')).toMatch(
      /summary|score/,
    );
    expect(checkOutputSchema({ list: [1] }, { list: 'array' })).toEqual([]);
    expect(checkOutputSchema({ any: { a: 1 } }, { any: 'any' })).toEqual([]);
  });
});

describe('executeNode', () => {
  let db: ReturnType<typeof makeFakeWorkflowDb>;

  beforeEach(() => {
    db = makeFakeWorkflowDb();
  });

  function deps(generate: any) {
    return {
      db: db as any,
      resolveProfile: async () => TEST_PROFILE,
      assembleTools: async () => ({}),
      generate,
    };
  }

  it('creates a workflow-channel session, runs the agent, persists outputs on the row', async () => {
    const run = await makeRun(db);
    const out = await executeNode(
      deps(async () => ({
        text: '```json\n{"summary":"好","score":8}\n```',
        usage: { inputTokens: 10, outputTokens: 20 },
        steps: [],
      })),
      {
        run,
        node,
        attempt: 1,
        resolvedInputs: { task: run.task_input },
        parentSessionId: 'chat_1',
      },
    );

    expect(out.status).toBe('passed');
    expect(out.outputs).toEqual({ summary: '好', score: 8 });
    expect(out.tokens).toBe(30);

    const row = db._nodeRuns[0]!;
    expect(row.status).toBe('passed');
    expect(JSON.parse(row.outputs!)).toEqual({ summary: '好', score: 8 });
    expect(row.session_id).toBeTruthy();

    const session = db._sessions.get(row.session_id!)!;
    expect(session.channel).toBe('workflow');
    expect(session.parent_session_id).toBe('chat_1');
    // node session got the brief as user msg + persisted assistant answer
    const msgs = db._messages.filter((m: any) => m.session_id === row.session_id);
    expect(msgs.map((m: any) => m.role)).toEqual(['user', 'assistant']);
  });

  it('injects the run owner\u2019s memory index ahead of the node addendum', async () => {
    // A workflow node acts for the run owner, so it works to the same remembered
    // preferences a chat turn would. The node's own brief must stay last.
    const run = await makeRun(db);
    let seenSystem = '';
    const generate = async (args: any) => {
      seenSystem = args.system;
      return { text: '```json\n{"summary":"ok","score":1}\n```', usage: {}, steps: [] };
    };
    await executeNode(
      {
        ...deps(generate),
        resolveUserContext: async () => '### Memory\n- [preference] Prefers metric units (id: 4)',
      },
      { run, node, attempt: 1, resolvedInputs: {}, parentSessionId: null },
    );

    expect(seenSystem).toContain('Prefers metric units');
    expect(seenSystem.indexOf('Prefers metric units')).toBeLessThan(
      seenSystem.indexOf('\u672c\u8282\u70b9\u9644\u52a0\u8981\u6c42'),
    );
  });

  it('runs without memory when no user context resolver is wired', async () => {
    const run = await makeRun(db);
    let seenSystem = '';
    const generate = async (args: any) => {
      seenSystem = args.system;
      return { text: '```json\n{"summary":"ok","score":1}\n```', usage: {}, steps: [] };
    };
    const out = await executeNode(deps(generate), {
      run,
      node,
      attempt: 1,
      resolvedInputs: {},
      parentSessionId: null,
    });

    expect(out.status).toBe('passed');
    expect(seenSystem).not.toContain('## User Context');
  });

  it('repairs once when the first answer has no valid JSON', async () => {
    const run = await makeRun(db);
    let calls = 0;
    const generate = async () => {
      calls += 1;
      return calls === 1
        ? { text: '光说话不给 JSON', usage: {}, steps: [] }
        : { text: '```json\n{"summary":"补","score":1}\n```', usage: {}, steps: [] };
    };
    const out = await executeNode(deps(generate), {
      run,
      node,
      attempt: 1,
      resolvedInputs: {},
      parentSessionId: null,
    });
    expect(calls).toBe(2);
    expect(out.status).toBe('passed');
    expect(out.outputs).toEqual({ summary: '补', score: 1 });
  });

  it('fails the attempt when repair also yields invalid output', async () => {
    const run = await makeRun(db);
    const out = await executeNode(
      deps(async () => ({ text: 'nope', usage: {}, steps: [] })),
      {
        run,
        node,
        attempt: 1,
        resolvedInputs: {},
        parentSessionId: null,
      },
    );
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/schema|JSON/i);
    expect(db._nodeRuns[0]!.status).toBe('failed');
  });

  it('fails cleanly when the model call throws', async () => {
    const run = await makeRun(db);
    const out = await executeNode(
      deps(async () => {
        throw new Error('model exploded');
      }),
      { run, node, attempt: 1, resolvedInputs: {}, parentSessionId: null },
    );
    expect(out.status).toBe('failed');
    expect(out.error).toContain('model exploded');
    // the failure is persisted — never a silently blank row
    expect(db._nodeRuns[0]!.status).toBe('failed');
    expect(db._nodeRuns[0]!.error).toContain('model exploded');
  });

  it('fails closed without a stale assistant when the node prompt is edited mid-run', async () => {
    const run = await makeRun(db);
    const out = await executeNode(
      deps(async () => {
        db._messages.at(-1).content = 'edited workflow prompt';
        return {
          text: '```json\n{"summary":"stale","score":0}\n```',
          usage: {},
          steps: [],
        };
      }),
      { run, node, attempt: 1, resolvedInputs: {}, parentSessionId: null },
    );

    expect(out.status).toBe('failed');
    expect(out.error).toContain('transcript changed');
    const sessionMessages = db._messages.filter((message: any) => message.session_id === out.sessionId);
    expect(sessionMessages).toHaveLength(1);
    expect(sessionMessages[0]).toMatchObject({ role: 'user', content: 'edited workflow prompt' });
  });

  it('nodes without an output_schema pass with raw text as outputs', async () => {
    const run = await makeRun(db);
    const freeNode: WorkflowNode = { id: 'free', agent: 'team', brief: { objective: '自由发挥' } };
    const out = await executeNode(
      deps(async () => ({ text: '纯文本结论', usage: {}, steps: [] })),
      {
        run,
        node: freeNode,
        attempt: 1,
        resolvedInputs: {},
        parentSessionId: null,
      },
    );
    expect(out.status).toBe('passed');
    expect(out.outputs).toEqual({ text: '纯文本结论' });
  });
});
