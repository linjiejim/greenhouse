/**
 * Terminal write-back — the run's outcome lands in the orchestrating
 * conversation exactly once.
 *
 * The "exactly once" half is the load-bearing one: a cancel racing the drive
 * loop's own finalization, or a boot sweep re-driving a run, must never append
 * a second assistant message (session-modes spec D3, discipline copied from the
 * Cloud Agent controller).
 */

import { describe, it, expect } from 'vitest';
import type { WorkflowGraph } from '@greenhouse/types/workflow';
import { driveRun, applyGateDecision } from '../runner.js';
import { settleRun, outcomeContent } from '../outcome.js';
import { makeFakeWorkflowDb, stubExecutor, type FakeWorkflowDb } from './fake-db.js';

const SOLO: WorkflowGraph = {
  nodes: [{ id: 'only', agent: 'team', brief: { objective: 'only' }, policy: { max_retry: 0 } }],
  deliverable_node: 'only',
};

function deps(db: any, exec: any, extra: Record<string, unknown> = {}) {
  return { db, executeNode: exec, reviewNode: async () => ({ pass: true }), emit: () => {}, ...extra } as any;
}

/** A workflow + run pair anchored to an orchestrating chat session. */
async function makeSessionRun(db: FakeWorkflowDb, graph: WorkflowGraph = SOLO) {
  const session = await db.sessions.create('chat', 'sprouty-quick', 'u1');
  const wf = await db.workflows.create({
    user_id: 'u1',
    name: '竞品调研',
    graph: JSON.stringify(graph),
    created_from_session_id: session.id,
  });
  await db.workflows.update(wf.id, { status: 'confirmed' });
  const run = await db.workflows.createRun({
    id: `run_${wf.id}`,
    workflow_id: wf.id,
    workflow_version: wf.version,
    user_id: 'u1',
    task_input: '调研竞品',
    graph: JSON.stringify(graph),
    budget: JSON.stringify({ max_nodes: 10, concurrency: 2, max_tokens: 1_000_000 }),
    total: graph.nodes.length,
  });
  return { session, wf, run };
}

const assistantMessages = (db: FakeWorkflowDb, sessionId: string) =>
  db._messages.filter((m) => m.session_id === sessionId && m.role === 'assistant');

describe('workflow outcome write-back', () => {
  it('writes one assistant message with the deliverable body when a run completes', async () => {
    const db = makeFakeWorkflowDb();
    const { session, run } = await makeSessionRun(db);
    const report = 'A'.repeat(200);
    const { exec } = stubExecutor(db, { only: [{ outputs: { report, score: 7 } }] });

    await driveRun(deps(db, exec), run.id);

    expect((await db.workflows.getRun(run.id))!.status).toBe('completed');
    const messages = assistantMessages(db, session.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain(report);
    // The guidance points at where the full deliverable lives.
    expect(messages[0].content).toContain('task dock');
  });

  it('falls back to a named completion line when the deliverable has no prose', async () => {
    const db = makeFakeWorkflowDb();
    const { session, run } = await makeSessionRun(db);
    const { exec } = stubExecutor(db, { only: [{ outputs: { count: 3 } }] });

    await driveRun(deps(db, exec), run.id);

    expect(assistantMessages(db, session.id)[0].content).toContain('竞品调研');
  });

  it('writes the failure reason when the run fails', async () => {
    const db = makeFakeWorkflowDb();
    const { session, run } = await makeSessionRun(db);

    await settleRun(db as any, run.id, { status: 'failed', error: 'node blew up' });

    const messages = assistantMessages(db, session.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('node blew up');
  });

  it('only the winner of the terminal CAS writes — a late cancel is a no-op', async () => {
    const db = makeFakeWorkflowDb();
    const { session, run } = await makeSessionRun(db);
    const { exec } = stubExecutor(db, { only: [{ outputs: { done: true } }] });

    await driveRun(deps(db, exec), run.id);
    // The cancel arrives after the loop already finalized the run.
    const won = await settleRun(db as any, run.id, { status: 'canceled' });

    expect(won).toBe(false);
    expect((await db.workflows.getRun(run.id))!.status).toBe('completed');
    expect(assistantMessages(db, session.id)).toHaveLength(1);
  });

  it('re-driving a finished run does not append a second message', async () => {
    const db = makeFakeWorkflowDb();
    const { session, run } = await makeSessionRun(db);
    const { exec } = stubExecutor(db, { only: [{ outputs: { done: true } }] });

    await driveRun(deps(db, exec), run.id);
    await driveRun(deps(db, exec), run.id); // boot sweep style re-entry

    expect(assistantMessages(db, session.id)).toHaveLength(1);
  });

  it('aborting an escalation gate writes the failure into the conversation', async () => {
    const db = makeFakeWorkflowDb();
    const { session, run } = await makeSessionRun(db);
    const gate = await db.workflows.createGate({
      run_id: run.id,
      node_id: 'only',
      kind: 'escalation',
      payload: JSON.stringify({ reason: 'max_retry_exhausted' }),
    });

    await applyGateDecision(
      deps(db, async () => ({}) as any),
      gate.id,
      {
        status: 'rejected',
        decided_by: 'u1',
        note: '不值得继续',
      },
    );

    expect((await db.workflows.getRun(run.id))!.status).toBe('failed');
    expect(assistantMessages(db, session.id)[0].content).toContain('不值得继续');
  });

  it('stays silent for runs with no orchestrating conversation', async () => {
    const db = makeFakeWorkflowDb();
    const wf = await db.workflows.create({ user_id: 'u1', name: 'headless', graph: JSON.stringify(SOLO) });
    const run = await db.workflows.createRun({
      id: 'run_headless',
      workflow_id: wf.id,
      workflow_version: wf.version,
      user_id: 'u1',
      task_input: 'x',
      graph: JSON.stringify(SOLO),
      budget: '{}',
      total: 1,
    });

    await settleRun(db as any, run.id, { status: 'failed', error: 'boom' });

    expect(db._messages).toHaveLength(0);
  });
});

describe('outcomeContent', () => {
  it('prefers an explicitly named prose field over the longest string', () => {
    const summary = JSON.stringify({ notes: 'x'.repeat(500), report: '简短但权威的结论' });
    expect(outcomeContent('completed', 'wf', summary, null)).toContain('简短但权威的结论');
  });

  it('degrades to the completion line for a null summary', () => {
    expect(outcomeContent('completed', 'wf', null, null)).toContain('“wf” completed');
  });

  it('names the workflow when canceled', () => {
    expect(outcomeContent('canceled', 'wf', null, null)).toBe('Workflow “wf” was canceled.');
  });
});
