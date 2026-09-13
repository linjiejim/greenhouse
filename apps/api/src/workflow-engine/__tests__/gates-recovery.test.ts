/**
 * Phase 3 behavior: human gates (before/after), reviewer return loop with
 * max_return, escalation decisions (retry/skip/abort), and restart recovery.
 */

import { describe, it, expect } from 'vitest';
import type { WorkflowGraph } from '@greenhouse/types/workflow';
import { driveRun, applyGateDecision, resumeActiveRuns } from '../runner.js';
import { makeFakeWorkflowDb, makeRun, stubExecutor } from './fake-db.js';

function deps(db: any, exec: any, extra: Record<string, unknown> = {}) {
  return { db, executeNode: exec, reviewNode: async () => ({ pass: true }), emit: () => {}, ...extra } as any;
}

describe('before_node human gate', () => {
  const graph: WorkflowGraph = {
    nodes: [{ id: 'guarded', agent: 'team', brief: { objective: 'x' }, gates: { before: 'human' } }],
    deliverable_node: 'guarded',
  };

  it('pauses before execution; approval releases the node', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, graph);
    const { exec, calls } = stubExecutor(db, { guarded: [{ outputs: { ok: 1 } }] });
    const d = deps(db, exec);

    await driveRun(d, run.id);
    expect(calls).toHaveLength(0); // did NOT execute
    const [gate] = await db.workflows.listPendingGates(run.id);
    expect(gate.kind).toBe('before_node');
    expect((await db.workflows.getRun(run.id)).status).toBe('paused_for_gate');

    await applyGateDecision(d, gate.id, { status: 'approved', decided_by: 'u1' });
    await driveRun(d, run.id);
    expect(calls).toHaveLength(1);
    expect((await db.workflows.getRun(run.id)).status).toBe('completed');
  });

  it('rejecting a before gate skips the node', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, graph);
    const { exec, calls } = stubExecutor(db, {});
    const d = deps(db, exec);
    await driveRun(d, run.id);
    const [gate] = await db.workflows.listPendingGates(run.id);
    await applyGateDecision(d, gate.id, { status: 'rejected', decided_by: 'u1', note: '不需要跑' });
    await driveRun(d, run.id);
    expect(calls).toHaveLength(0);
    const rows = await db.workflows.listNodeRuns(run.id);
    expect(rows.at(-1)!.status).toBe('skipped');
    expect((await db.workflows.getRun(run.id)).status).toBe('completed');
  });
});

describe('after_node human gate', () => {
  const graph: WorkflowGraph = {
    nodes: [
      { id: 'work', agent: 'team', brief: { objective: 'x' }, gates: { after: 'human' }, policy: { max_return: 1 } },
      { id: 'next', agent: 'team', brief: { objective: 'y' }, depends_on: ['work'] },
    ],
    deliverable_node: 'next',
  };

  it('holds the output for approval; approval unblocks downstream', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, graph);
    const { exec, calls } = stubExecutor(db, {
      work: [{ outputs: { v: 1 } }],
      next: [{ outputs: { done: true } }],
    });
    const d = deps(db, exec);

    await driveRun(d, run.id);
    expect(calls.map((c) => c.node)).toEqual(['work']); // next not scheduled yet
    const rows = await db.workflows.listNodeRuns(run.id);
    expect(rows[0]!.status).toBe('awaiting_gate');
    const [gate] = await db.workflows.listPendingGates(run.id);
    expect(gate.kind).toBe('after_node');
    expect(JSON.parse(gate.payload).outputs).toEqual({ v: 1 });

    await applyGateDecision(d, gate.id, { status: 'approved', decided_by: 'u1' });
    await driveRun(d, run.id);
    expect(calls.map((c) => c.node)).toEqual(['work', 'next']);
    expect((await db.workflows.getRun(run.id)).status).toBe('completed');
  });

  it('rejection returns the node with feedback, bounded by max_return', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, graph);
    const { exec, calls } = stubExecutor(db, {
      work: [{ outputs: { v: 1 } }, { outputs: { v: 2 } }],
      next: [{ outputs: {} }],
    });
    const d = deps(db, exec);

    await driveRun(d, run.id);
    const [gate1] = await db.workflows.listPendingGates(run.id);
    await applyGateDecision(d, gate1.id, { status: 'rejected', decided_by: 'u1', note: '缺定价分析' });
    await driveRun(d, run.id);

    // re-ran with the human feedback
    expect(calls[1]!.node).toBe('work');
    expect(calls[1]!.attempt).toBe(2);
    expect(calls[1]!.feedback).toContain('缺定价分析');

    // second rejection exceeds max_return=1 → escalation
    const [gate2] = await db.workflows.listPendingGates(run.id);
    expect(gate2.kind).toBe('after_node');
    await applyGateDecision(d, gate2.id, { status: 'rejected', decided_by: 'u1', note: '还是不行' });
    await driveRun(d, run.id);
    const pend = await db.workflows.listPendingGates(run.id);
    expect(pend).toHaveLength(1);
    expect(pend[0]!.kind).toBe('escalation');
  });
});

describe('reviewer check loop', () => {
  const graph: WorkflowGraph = {
    nodes: [
      {
        id: 'writer',
        agent: 'team',
        brief: { objective: '写' },
        checks: [{ type: 'reviewer', criteria: '必须含定价' }],
        policy: { max_return: 1 },
      },
    ],
    deliverable_node: 'writer',
  };

  it('failed review returns the node with feedback; pass on second attempt', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, graph);
    const { exec, calls } = stubExecutor(db, {
      writer: [{ outputs: { doc: 'v1' } }, { outputs: { doc: 'v2 含定价' } }],
    });
    const reviews: any[] = [];
    const reviewNode = async (args: any) => {
      reviews.push(args);
      return reviews.length === 1 ? { pass: false, feedback: '缺定价', tokens: 5 } : { pass: true, tokens: 5 };
    };
    const d = deps(db, exec, { reviewNode });

    await driveRun(d, run.id);

    expect(reviews).toHaveLength(2);
    expect(reviews[0].criteria).toBe('必须含定价');
    expect(reviews[0].outputs).toEqual({ doc: 'v1' });
    expect(calls[1]!.feedback).toContain('缺定价');
    const rows = await db.workflows.listNodeRuns(run.id);
    expect(rows.map((r: any) => r.status)).toEqual(['returned', 'passed']);
    const finished = await db.workflows.getRun(run.id);
    expect(finished.status).toBe('completed');
    expect(finished.tokens_used).toBe(30); // 10+10 exec + 5+5 review
  });

  it('escalates when reviews keep failing past max_return', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, graph);
    const { exec } = stubExecutor(db, { writer: [{ outputs: { doc: 'v1' } }, { outputs: { doc: 'v2' } }] });
    const d = deps(db, exec, { reviewNode: async () => ({ pass: false, feedback: '不行' }) });

    await driveRun(d, run.id);

    const pend = await db.workflows.listPendingGates(run.id);
    expect(pend).toHaveLength(1);
    expect(pend[0]!.kind).toBe('escalation');
    expect((await db.workflows.getRun(run.id)).status).toBe('paused_for_gate');
  });
});

describe('escalation decisions', () => {
  const graph: WorkflowGraph = {
    nodes: [
      { id: 'doomed', agent: 'team', brief: { objective: 'x' }, policy: { max_retry: 0 } },
      { id: 'after', agent: 'team', brief: { objective: 'y' }, depends_on: ['doomed'] },
    ],
    deliverable_node: 'after',
  };

  async function setup(execPlan: any) {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, graph);
    const stub = stubExecutor(db, execPlan);
    const d = deps(db, stub.exec);
    await driveRun(d, run.id); // doomed fails → escalation
    const [gate] = await db.workflows.listPendingGates(run.id);
    expect(gate.kind).toBe('escalation');
    return { db, run, d, gate, stub };
  }

  it('retry grants another attempt', async () => {
    const { db, run, d, gate, stub } = await setup({
      doomed: [{ error: 'e' }, { outputs: { ok: 1 } }],
      after: [{ outputs: {} }],
    });
    await applyGateDecision(d, gate.id, { status: 'approved', decided_by: 'u1', note: 'retry' });
    await driveRun(d, run.id);
    expect(stub.calls.map((c) => `${c.node}#${c.attempt}`)).toEqual(['doomed#1', 'doomed#2', 'after#1']);
    expect((await db.workflows.getRun(run.id)).status).toBe('completed');
  });

  it('skip marks the node skipped and downstream proceeds with null outputs', async () => {
    const { db, run, d, gate, stub } = await setup({ doomed: [{ error: 'e' }], after: [{ outputs: {} }] });
    await applyGateDecision(d, gate.id, { status: 'approved', decided_by: 'u1', note: 'skip' });
    await driveRun(d, run.id);
    expect(stub.calls.at(-1)!.node).toBe('after');
    const rows = await db.workflows.listNodeRuns(run.id);
    expect(rows.find((r: any) => r.node_id === 'doomed' && r.status === 'skipped')).toBeTruthy();
    expect((await db.workflows.getRun(run.id)).status).toBe('completed');
  });

  it('abort (reject) fails the run', async () => {
    const { db, run, d, gate } = await setup({ doomed: [{ error: 'e' }] });
    await applyGateDecision(d, gate.id, { status: 'rejected', decided_by: 'u1', note: '算了' });
    const finished = await db.workflows.getRun(run.id);
    expect(finished.status).toBe('failed');
    expect(finished.error).toMatch(/abort/i);
    expect(finished.finished_at).toBeTruthy();
  });
});

describe('restart recovery (boot sweep)', () => {
  it('re-runs nodes stranded in running and completes the run', async () => {
    const db = makeFakeWorkflowDb();
    const graph: WorkflowGraph = {
      nodes: [{ id: 'solo', agent: 'team', brief: { objective: 'x' }, policy: { max_retry: 1 } }],
      deliverable_node: 'solo',
    };
    const run = await makeRun(db, graph);
    // simulate a crash: row stuck in 'running'
    const row = await db.workflows.createNodeRun({ run_id: run.id, node_id: 'solo', attempt: 1 });
    await db.workflows.updateNodeRun(row.id, { status: 'running', started_at: new Date().toISOString() });

    const { exec, calls } = stubExecutor(db, { solo: [{ outputs: { ok: 1 } }] });
    await resumeActiveRuns(deps(db, exec));

    // stranded attempt was failed, then retried per policy
    const rows = await db.workflows.listNodeRuns(run.id);
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.error).toMatch(/restart/i);
    expect(calls.map((c) => c.attempt)).toEqual([2]);
    expect((await db.workflows.getRun(run.id)).status).toBe('completed');
  });

  it('a paused run with a pending gate survives resume untouched (no duplicate gates)', async () => {
    const db = makeFakeWorkflowDb();
    const graph: WorkflowGraph = {
      nodes: [{ id: 'guarded', agent: 'team', brief: { objective: 'x' }, gates: { before: 'human' } }],
      deliverable_node: 'guarded',
    };
    const run = await makeRun(db, graph);
    const { exec, calls } = stubExecutor(db, {});
    const d = deps(db, exec);
    await driveRun(d, run.id); // creates the before gate + pauses

    await resumeActiveRuns(d);

    expect(calls).toHaveLength(0);
    expect(await db.workflows.listPendingGates(run.id)).toHaveLength(1);
    expect((await db.workflows.getRun(run.id)).status).toBe('paused_for_gate');
  });
});
