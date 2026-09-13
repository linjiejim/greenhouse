/**
 * driveRun — dependency scheduling, blackboard flow, parallelism, retry,
 * budget guard and completion. Fake db + stubbed node executor.
 */

import { describe, it, expect } from 'vitest';
import type { WorkflowGraph } from '@greenhouse/types/workflow';
import { driveRun } from '../runner.js';
import { makeFakeWorkflowDb, makeRun, stubExecutor } from './fake-db.js';

const LINEAR: WorkflowGraph = {
  nodes: [
    { id: 'research', agent: 'team', brief: { objective: '调研', output_schema: { finding: 'string' } } },
    {
      id: 'draft',
      agent: 'team',
      brief: { objective: '起草', inputs: { finding: '$nodes.research.outputs.finding', task: '$run.input' } },
      depends_on: ['research'],
    },
    {
      id: 'deliver',
      agent: 'team',
      brief: { objective: '交付', inputs: { doc: '$nodes.draft.outputs' } },
      depends_on: ['draft'],
    },
  ],
  deliverable_node: 'deliver',
};

const DIAMOND: WorkflowGraph = {
  nodes: [
    { id: 'a', agent: 'team', brief: { objective: 'A' } },
    { id: 'b', agent: 'team', brief: { objective: 'B' } },
    { id: 'join', agent: 'team', brief: { objective: 'join' }, depends_on: ['a', 'b'] },
  ],
  deliverable_node: 'join',
};

function deps(db: any, exec: any, extra: Record<string, unknown> = {}) {
  return { db, executeNode: exec, reviewNode: async () => ({ pass: true }), emit: () => {}, ...extra } as any;
}

describe('driveRun — linear chain', () => {
  it('runs nodes in dependency order, flows the blackboard, completes with deliverable summary', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, LINEAR, { taskInput: '写方案' });
    const { exec, calls } = stubExecutor(db, {
      research: [{ outputs: { finding: '市场很大' } }],
      draft: [{ outputs: { doc: '草稿完成' } }],
      deliver: [{ outputs: { report: '最终报告' } }],
    });

    await driveRun(deps(db, exec), run.id);

    expect(calls.map((c) => c.node)).toEqual(['research', 'draft', 'deliver']);
    // blackboard flowed upstream outputs into downstream inputs
    expect(calls[1]!.resolvedInputs).toEqual({ finding: '市场很大', task: '写方案' });
    expect(calls[2]!.resolvedInputs).toEqual({ doc: { doc: '草稿完成' } });

    const finished = await db.workflows.getRun(run.id);
    expect(finished.status).toBe('completed');
    expect(finished.completed).toBe(3);
    expect(finished.finished_at).toBeTruthy();
    expect(JSON.parse(finished.summary)).toEqual({ report: '最终报告' });
    expect(finished.tokens_used).toBe(30);
  });
});

describe('driveRun — parallelism', () => {
  it('launches independent nodes concurrently within the budget', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, DIAMOND, { budget: { concurrency: 3 } });
    const { exec, peak } = stubExecutor(db, {
      a: [{ outputs: {}, delayMs: 30 }],
      b: [{ outputs: {}, delayMs: 30 }],
      join: [{ outputs: { ok: true } }],
    });

    await driveRun(deps(db, exec), run.id);
    expect(peak()).toBe(2); // a + b overlapped; join waited for both
    expect((await db.workflows.getRun(run.id)).status).toBe('completed');
  });

  it('respects concurrency=1 (strictly sequential)', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, DIAMOND, { budget: { concurrency: 1 } });
    const { exec, peak } = stubExecutor(db, {
      a: [{ outputs: {}, delayMs: 20 }],
      b: [{ outputs: {}, delayMs: 20 }],
    });
    await driveRun(deps(db, exec), run.id);
    expect(peak()).toBe(1);
  });
});

describe('driveRun — retry & escalation', () => {
  it('retries a failed node within max_retry and then succeeds', async () => {
    const db = makeFakeWorkflowDb();
    const graph: WorkflowGraph = {
      nodes: [{ id: 'flaky', agent: 'team', brief: { objective: 'x' }, policy: { max_retry: 1 } }],
      deliverable_node: 'flaky',
    };
    const run = await makeRun(db, graph);
    const { exec, calls } = stubExecutor(db, {
      flaky: [{ error: 'boom' }, { outputs: { ok: 1 } }],
    });

    await driveRun(deps(db, exec), run.id);

    expect(calls.map((c) => c.attempt)).toEqual([1, 2]);
    const rows = await db.workflows.listNodeRuns(run.id);
    expect(rows.map((r: any) => r.status)).toEqual(['failed', 'passed']);
    expect((await db.workflows.getRun(run.id)).status).toBe('completed');
  });

  it('escalates to a human gate when retries are exhausted', async () => {
    const db = makeFakeWorkflowDb();
    const graph: WorkflowGraph = {
      nodes: [{ id: 'doomed', agent: 'team', brief: { objective: 'x' }, policy: { max_retry: 1 } }],
      deliverable_node: 'doomed',
    };
    const run = await makeRun(db, graph);
    const { exec } = stubExecutor(db, { doomed: [{ error: 'e1' }, { error: 'e2' }] });

    await driveRun(deps(db, exec), run.id);

    const gates = await db.workflows.listPendingGates(run.id);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.kind).toBe('escalation');
    expect(gates[0]!.node_id).toBe('doomed');
    expect((await db.workflows.getRun(run.id)).status).toBe('paused_for_gate');
  });

  it('does not duplicate the escalation gate when driven again', async () => {
    const db = makeFakeWorkflowDb();
    const graph: WorkflowGraph = {
      nodes: [{ id: 'doomed', agent: 'team', brief: { objective: 'x' }, policy: { max_retry: 0 } }],
      deliverable_node: 'doomed',
    };
    const run = await makeRun(db, graph);
    const { exec } = stubExecutor(db, { doomed: [{ error: 'e1' }] });
    await driveRun(deps(db, exec), run.id);
    await driveRun(deps(db, exec), run.id); // e.g. boot sweep re-drives
    expect(await db.workflows.listPendingGates(run.id)).toHaveLength(1);
  });
});

describe('driveRun — budget guard', () => {
  it('pauses with a budget escalation gate instead of silently continuing', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, LINEAR, { budget: { max_tokens: 100 } });
    const { exec, calls } = stubExecutor(db, {
      research: [{ outputs: { finding: 'x' }, tokens: 150 }],
    });

    await driveRun(deps(db, exec), run.id);

    // research ran, but draft must NOT have been scheduled
    expect(calls.map((c) => c.node)).toEqual(['research']);
    const gates = await db.workflows.listPendingGates(run.id);
    expect(gates).toHaveLength(1);
    expect(JSON.parse(gates[0]!.payload).reason).toBe('budget_exceeded');
    expect((await db.workflows.getRun(run.id)).status).toBe('paused_for_gate');
  });
});
