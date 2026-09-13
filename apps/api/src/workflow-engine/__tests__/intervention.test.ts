/**
 * Mid-flight intervention — user pause/resume and node-level retry/skip.
 *
 * These are the manual overrides that sit outside the gate ladder: pausing must
 * stop the scheduler without killing work already in flight, and requeueing a
 * node must be able to rescue a run that already reached `failed`.
 */

import { describe, it, expect } from 'vitest';
import type { WorkflowGraph } from '@greenhouse/types/workflow';
import { driveRun, pauseRun, resumeRun, requeueNode } from '../runner.js';
import { makeFakeWorkflowDb, makeRun, stubExecutor } from './fake-db.js';

const CHAIN: WorkflowGraph = {
  nodes: [
    { id: 'a', agent: 'team', brief: { objective: 'A' } },
    { id: 'b', agent: 'team', brief: { objective: 'B' }, depends_on: ['a'] },
  ],
  deliverable_node: 'b',
};

const SOLO: WorkflowGraph = {
  nodes: [{ id: 'only', agent: 'team', brief: { objective: 'only' }, policy: { max_retry: 0 } }],
  deliverable_node: 'only',
};

function deps(db: any, exec: any, extra: Record<string, unknown> = {}) {
  return { db, executeNode: exec, reviewNode: async () => ({ pass: true }), emit: () => {}, ...extra } as any;
}

describe('pause / resume', () => {
  it('pauses a running run and stops the scheduler from launching anything', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, CHAIN);
    const { exec, calls } = stubExecutor(db, {});

    await pauseRun(db as any, run.id);
    expect((await db.workflows.getRun(run.id))!.status).toBe('paused');

    await driveRun(deps(db, exec), run.id);
    expect(calls).toHaveLength(0);
  });

  it('resumes from where it stopped without re-running finished nodes', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, CHAIN);
    const { exec, calls } = stubExecutor(db, { a: [{ outputs: { v: 1 } }], b: [{ outputs: { v: 2 } }] });

    // Run node 'a' only, then pause before 'b' is picked up.
    await db.workflows.createNodeRun({ run_id: run.id, node_id: 'a', attempt: 1, status: 'passed' });
    await pauseRun(db as any, run.id);
    await driveRun(deps(db, exec), run.id);
    expect(calls).toHaveLength(0);
    // Pausing settles the progress counter so the paused card is not stale.
    expect((await db.workflows.getRun(run.id))!.completed).toBe(1);

    await resumeRun(db as any, run.id);
    expect((await db.workflows.getRun(run.id))!.status).toBe('running');
    await driveRun(deps(db, exec), run.id);

    expect(calls.map((c) => c.node)).toEqual(['b']);
    expect((await db.workflows.getRun(run.id))!.status).toBe('completed');
  });

  it('refuses to pause a terminal run and to resume one that is not paused', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, CHAIN);
    await db.workflows.updateRun(run.id, { status: 'completed' });
    await expect(pauseRun(db as any, run.id)).rejects.toThrow(/completed/);

    const other = await makeRun(db, CHAIN);
    await expect(resumeRun(db as any, other.id)).rejects.toThrow(/not paused/);
  });

  it('waits for a node still in flight from another loop instead of declaring a stall', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, SOLO);
    // Simulate the row left behind by a drive loop that exited on pause.
    const row = await db.workflows.createNodeRun({ run_id: run.id, node_id: 'only', attempt: 1, status: 'running' });
    const { exec, calls } = stubExecutor(db, {});

    const driving = driveRun(deps(db, exec), run.id);
    // Let the loop observe the foreign row, then land it.
    await new Promise((r) => setTimeout(r, 30));
    await db.workflows.updateNodeRun(row.id, { status: 'passed', outputs: JSON.stringify({ v: 1 }) });
    await driving;

    expect(calls).toHaveLength(0);
    const finished = await db.workflows.getRun(run.id);
    expect(finished!.status).toBe('completed');
    expect(finished!.error).toBeNull();
  });
});

describe('run graph is frozen at confirm time', () => {
  it('executes the snapshot even after the definition is rewritten', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, CHAIN);

    // Someone revises (or clobbers) the definition while the run is pending.
    await db.workflows.update(run.workflow_id, {
      graph: JSON.stringify({
        nodes: [{ id: 'totally-different', agent: 'team', brief: { objective: 'X' } }],
        deliverable_node: 'totally-different',
      }),
      bumpVersion: true,
    });

    const { exec, calls } = stubExecutor(db, { a: [{ outputs: { v: 1 } }], b: [{ outputs: { v: 2 } }] });
    await driveRun(deps(db, exec), run.id);

    expect(calls.map((c) => c.node)).toEqual(['a', 'b']);
    expect((await db.workflows.getRun(run.id))!.status).toBe('completed');
  });

  it('falls back to the definition for pre-snapshot runs', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, CHAIN);
    (await db.workflows.getRun(run.id))!.graph = null; // row created before the column existed

    const { exec, calls } = stubExecutor(db, { a: [{ outputs: { v: 1 } }], b: [{ outputs: { v: 2 } }] });
    await driveRun(deps(db, exec), run.id);

    expect(calls.map((c) => c.node)).toEqual(['a', 'b']);
  });
});

describe('node retry / skip', () => {
  it('retries a failed node and lets the run continue', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, SOLO);
    const { exec, calls } = stubExecutor(db, { only: [{ error: 'boom' }] });

    await driveRun(deps(db, exec), run.id);
    expect((await db.workflows.getRun(run.id))!.status).toBe('paused_for_gate');

    await requeueNode(db as any, { runId: run.id, nodeId: 'only', mode: 'retry', decidedBy: 'u1' });
    const { exec: exec2, calls: calls2 } = stubExecutor(db, { only: [{ outputs: { ok: true } }] });
    await driveRun(deps(db, exec2), run.id);

    expect(calls).toHaveLength(1);
    expect(calls2.map((c) => c.node)).toEqual(['only']);
    expect((await db.workflows.getRun(run.id))!.status).toBe('completed');
  });

  it('resolves the pending escalation gate so the run is not left waiting', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, SOLO);
    const { exec } = stubExecutor(db, { only: [{ error: 'boom' }] });
    await driveRun(deps(db, exec), run.id);

    await requeueNode(db as any, { runId: run.id, nodeId: 'only', mode: 'retry', decidedBy: 'u1' });
    expect(await db.workflows.listPendingGates(run.id)).toHaveLength(0);
    const gate = (await db.workflows.listGates(run.id)).at(-1)!;
    expect(gate.status).toBe('approved');
    expect(gate.decided_by).toBe('u1');
  });

  it('skips a failed node so downstream work proceeds', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, CHAIN);
    const { exec } = stubExecutor(db, { a: [{ error: 'boom' }, { error: 'boom again' }] });
    await driveRun(deps(db, exec), run.id);

    await requeueNode(db as any, { runId: run.id, nodeId: 'a', mode: 'skip', decidedBy: 'u1' });
    const { exec: exec2, calls } = stubExecutor(db, { b: [{ outputs: { v: 2 } }] });
    await driveRun(deps(db, exec2), run.id);

    expect(calls.map((c) => c.node)).toEqual(['b']);
    expect((await db.workflows.getRun(run.id))!.status).toBe('completed');
  });

  it('rescues a run that already reached failed (clears error, resumes driving)', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, SOLO);
    await db.workflows.createNodeRun({ run_id: run.id, node_id: 'only', attempt: 1, status: 'failed' });
    await db.workflows.updateRun(run.id, { status: 'failed', error: 'aborted by user', finished_at: 'x' });

    await requeueNode(db as any, { runId: run.id, nodeId: 'only', mode: 'retry', decidedBy: 'u1' });
    const revived = await db.workflows.getRun(run.id);
    expect(revived!.status).toBe('running');
    expect(revived!.error).toBeNull();
    expect(revived!.finished_at).toBeNull();

    const { exec, calls } = stubExecutor(db, { only: [{ outputs: { ok: true } }] });
    await driveRun(deps(db, exec), run.id);
    expect(calls.map((c) => c.node)).toEqual(['only']);
    expect((await db.workflows.getRun(run.id))!.status).toBe('completed');
  });

  it('refuses to requeue a node that already passed', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, SOLO);
    await db.workflows.createNodeRun({ run_id: run.id, node_id: 'only', attempt: 1, status: 'passed' });

    await expect(
      requeueNode(db as any, { runId: run.id, nodeId: 'only', mode: 'retry', decidedBy: 'u1' }),
    ).rejects.toThrow(/passed/);
  });

  it('refuses to requeue a node that is currently running, or an unknown node', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, SOLO);
    await db.workflows.createNodeRun({ run_id: run.id, node_id: 'only', attempt: 1, status: 'running' });

    await expect(
      requeueNode(db as any, { runId: run.id, nodeId: 'only', mode: 'retry', decidedBy: 'u1' }),
    ).rejects.toThrow(/running/);
    await expect(
      requeueNode(db as any, { runId: run.id, nodeId: 'ghost', mode: 'skip', decidedBy: 'u1' }),
    ).rejects.toThrow(/not in this workflow/);
  });

  it('refuses to requeue in a canceled run', async () => {
    const db = makeFakeWorkflowDb();
    const run = await makeRun(db, SOLO);
    await db.workflows.createNodeRun({ run_id: run.id, node_id: 'only', attempt: 1, status: 'failed' });
    await db.workflows.updateRun(run.id, { status: 'canceled' });

    await expect(
      requeueNode(db as any, { runId: run.id, nodeId: 'only', mode: 'retry', decidedBy: 'u1' }),
    ).rejects.toThrow(/canceled/);
  });
});
