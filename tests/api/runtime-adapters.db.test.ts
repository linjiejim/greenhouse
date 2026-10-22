import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';
import { mirrorWorkflowRun, workflowRuntimeRunId } from '../../apps/api/src/runtime/adapters.js';

let db: DatabaseProvider;
let user: UserRow;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random()}`;
}

describe('Runtime Workflow read-model adapter', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    user = await createInternalTestUser(db, { email: `${unique('runtime-adapter')}@test.local` });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('mirrors Workflow node attempts and gates while keeping the frozen graph in the source envelope', async () => {
    const workflow = await db.workflows.create({
      user_id: user.id,
      name: 'Launch plan',
      graph: JSON.stringify({ nodes: [{ id: 'draft' }], deliverable_node: 'draft' }),
    });
    let source = await db.workflows.createRun({
      id: unique('workflow-run'),
      workflow_id: workflow.id,
      workflow_version: workflow.version,
      user_id: user.id,
      task_input: 'Ship the launch',
      graph: workflow.graph,
      budget: JSON.stringify({ max_tokens: 42_000 }),
      total: 1,
    });
    const node = await db.workflows.createNodeRun({
      run_id: source.id,
      node_id: 'draft',
      status: 'running',
      inputs: JSON.stringify({ task: 'Ship the launch' }),
    });
    const gate = await db.workflows.createGate({
      run_id: source.id,
      node_id: 'draft',
      kind: 'after_node',
      payload: JSON.stringify({ review: 'full output' }),
    });

    let runtime = await mirrorWorkflowRun(db, source);
    expect(runtime).toMatchObject({ id: workflowRuntimeRunId(source.id), status: 'running' });
    let detail = (await db.runtime.getRunDetail(runtime.id))!;
    expect(JSON.parse(detail.run.input)).toMatchObject({
      graph: { nodes: [{ id: 'draft' }] },
      task_input: 'Ship the launch',
    });
    expect(detail.steps[0]).toMatchObject({ step_key: 'draft', status: 'running' });
    expect(detail.interrupts[0]).toMatchObject({ kind: 'workflow_gate', status: 'pending' });

    await db.workflows.updateNodeRun(node.id, {
      status: 'passed',
      outputs: JSON.stringify({ report: 'complete' }),
      tokens: 900,
      duration_ms: 250,
      finished_at: new Date().toISOString(),
    });
    await db.workflows.decideGate(gate.id, { status: 'approved', decided_by: user.id, note: 'ship' });
    source = (await db.workflows.transitionRun(source.id, ['running'], {
      status: 'completed',
      summary: JSON.stringify({ result: 'done' }),
      finished_at: new Date().toISOString(),
    }))!;
    runtime = await mirrorWorkflowRun(db, source);
    detail = (await db.runtime.getRunDetail(runtime.id))!;
    expect(runtime.status).toBe('succeeded');
    expect(detail.steps[0]).toMatchObject({ status: 'succeeded', tokens_used: 900, duration_ms: 250 });
    expect(detail.interrupts[0]?.status).toBe('resolved');
  });
});
