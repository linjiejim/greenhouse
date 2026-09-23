import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';
import {
  mirrorMissionRun,
  mirrorWorkflowRun,
  missionRuntimeRunId,
  workflowRuntimeRunId,
} from '../../apps/api/src/runtime/adapters.js';

let db: DatabaseProvider;
let user: UserRow;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random()}`;
}

describe('Runtime Mission/Workflow read-model adapters', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    user = await createInternalTestUser(db, { email: `${unique('runtime-adapter')}@test.local` });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('mirrors a Mission through legal states without duplicate events and retains exact evidence', async () => {
    const workspace = await db.agentRuns.createWorkspace({ user_id: user.id, name: 'runtime mirror' });
    let source = await db.agentRuns.createRun({
      user_id: user.id,
      workspace_id: workspace.id,
      title: 'Evidence retention',
      prompt: 'runner prompt',
      original_prompt: 'exact user prompt',
      input_manifest: JSON.stringify([{ name: 'input.csv', nested: { preserve: true } }]),
      model: 'deepseek-flash',
    });
    const fullPayload = { tool: 'shell', params: { command: 'x'.repeat(20_000) } };
    await db.agentRuns.appendEvents(source.id, [
      { seq: 1, type: 'tool.started', payload: JSON.stringify(fullPayload) },
    ]);
    await db.agentRuns.createArtifact({
      run_id: source.id,
      path: 'report/final.html',
      size_bytes: 123,
      content_type: 'text/html',
      sha256: 'a'.repeat(64),
      storage_key: 'runtime-test/report.html',
    });
    const approval = await db.agentRuns.requestApproval({
      run_id: source.id,
      user_id: user.id,
      tool_id: 'crm_mutation',
      action: 'update_company',
      input_hash: 'input-hash',
      input_json: JSON.stringify({ company_id: 7, fields: { stage: 'won' } }),
      ttl_ms: 60_000,
    });

    let runtime = await mirrorMissionRun(db, source);
    expect(runtime).toMatchObject({ id: missionRuntimeRunId(source.id), status: 'queued', source_id: source.id });
    source = (await db.agentRuns.transitionRun(source.id, ['queued'], { status: 'running' }))!;
    runtime = await mirrorMissionRun(db, source);
    expect(runtime.status).toBe('running');

    const firstDetail = (await db.runtime.getRunDetail(runtime.id))!;
    expect(firstDetail.steps).toHaveLength(1);
    expect(firstDetail.steps[0]).toMatchObject({ step_key: 'sandbox-runner', status: 'running' });
    expect(firstDetail.artifacts).toHaveLength(1);
    expect(firstDetail.artifacts[0]).toMatchObject({ path: 'report/final.html', status: 'available' });
    expect(firstDetail.interrupts).toHaveLength(1);
    expect(JSON.parse(firstDetail.interrupts[0]!.payload)).toMatchObject({
      source: 'mission_approval',
      input: { company_id: 7 },
    });
    const mirroredSourceEvent = firstDetail.events.find((event) => event.type === 'mission.tool.started');
    expect(JSON.parse(mirroredSourceEvent!.payload)).toEqual(fullPayload);

    await mirrorMissionRun(db, source);
    expect((await db.runtime.listEvents(runtime.id)).length).toBe(firstDetail.events.length);

    await db.agentRuns.decideApproval(approval.id, source.id, user.id, 'approve', user.id);
    await mirrorMissionRun(db, source);
    expect((await db.runtime.getInterrupt(`rtmi_${approval.id}`))?.status).toBe('resolved');
  });

  it('suppresses only a new historical terminal backfill and preserves later compensation alerts', async () => {
    const workspace = await db.agentRuns.createWorkspace({ user_id: user.id, name: 'backfill notification policy' });
    let historical = await db.agentRuns.createRun({
      user_id: user.id,
      workspace_id: workspace.id,
      title: 'historical terminal',
      prompt: 'already done',
      model: 'deepseek-flash',
    });
    historical = (await db.agentRuns.transitionRun(historical.id, ['queued'], { status: 'running' }))!;
    historical = (await db.agentRuns.transitionRun(historical.id, ['running'], { status: 'completed' }))!;

    const historicalRuntime = await mirrorMissionRun(db, historical, {
      suppressInitialTerminalNotification: true,
    });
    const historicalEvents = await db.runtime.listEvents(historicalRuntime.id);
    expect(JSON.parse(historicalEvents.find((event) => event.type === 'run.created')!.payload)).toMatchObject({
      notification_policy: 'suppress_initial_terminal',
    });
    expect(
      JSON.parse(
        historicalEvents.find(
          (event) => event.type === 'run.status_changed' && JSON.parse(event.payload).result.status === 'succeeded',
        )!.payload,
      ),
    ).toMatchObject({ notification_policy: 'suppress', result: { status: 'succeeded' } });

    let later = await db.agentRuns.createRun({
      user_id: user.id,
      workspace_id: workspace.id,
      title: 'later terminal',
      prompt: 'finishes after boot',
      model: 'deepseek-flash',
    });
    // Boot sees an active run, so it must not persist the historical policy.
    await mirrorMissionRun(db, later, { suppressInitialTerminalNotification: true });
    later = (await db.agentRuns.transitionRun(later.id, ['queued'], { status: 'running' }))!;
    later = (await db.agentRuns.transitionRun(later.id, ['running'], { status: 'completed' }))!;
    const laterRuntime = await mirrorMissionRun(db, later);
    const laterEvents = await db.runtime.listEvents(laterRuntime.id);
    const laterTerminal = JSON.parse(
      laterEvents.find(
        (event) => event.type === 'run.status_changed' && JSON.parse(event.payload).result.status === 'succeeded',
      )!.payload,
    ) as Record<string, unknown>;
    expect(laterTerminal).not.toHaveProperty('notification_policy');
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

  it('provides stable keyset pages for full-history compensation scans', async () => {
    const workspace = await db.agentRuns.createWorkspace({ user_id: user.id, name: 'cursor' });
    await Promise.all(
      ['a', 'b', 'c'].map((suffix) =>
        db.agentRuns.createRun({
          user_id: user.id,
          workspace_id: workspace.id,
          title: suffix,
          prompt: suffix,
          model: 'deepseek-flash',
        }),
      ),
    );
    const first = await db.agentRuns.listRunsForRuntimeReconciliation({ limit: 1 });
    const second = await db.agentRuns.listRunsForRuntimeReconciliation({ cursor: first.next_cursor!, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
  });
});
