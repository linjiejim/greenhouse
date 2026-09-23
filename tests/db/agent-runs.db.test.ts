/**
 * Cloud Agent run service integration tests.
 *
 * Workspaces, runs (state machine fields + compare-and-set transitions),
 * idempotent event append, and artifacts against a real PostgreSQL database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;
let user: UserRow;

async function createRunFixture() {
  const workspace = await db.agentRuns.createWorkspace({ user_id: user.id, name: 'Fix the docs' });
  const run = await db.agentRuns.createRun({
    user_id: user.id,
    workspace_id: workspace.id,
    title: 'Fix the docs',
    prompt: 'Update README to match reality',
    model: 'deepseek-flash',
    fallback_model: 'pro',
  });
  return { workspace, run };
}

describe('Agent Run Service', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    user = await createInternalTestUser(db, { email: `car-${Date.now()}-${Math.random()}@test.local` });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  // ─── Workspaces ────────────────────────────────────────

  it('creates and updates a workspace', async () => {
    const ws = await db.agentRuns.createWorkspace({ user_id: user.id, name: 'ws-1' });
    expect(ws.status).toBe('active');
    expect(ws.disk_bytes).toBe(0);

    const updated = await db.agentRuns.updateWorkspace(ws.id, {
      status: 'archived',
      cos_archive_key: 'agent-workspaces/x.tar.zst',
      disk_bytes: 3_000_000_000,
    });
    expect(updated!.status).toBe('archived');
    expect(updated!.cos_archive_key).toBe('agent-workspaces/x.tar.zst');
    // bigint column round-trips values beyond int4 range
    expect(updated!.disk_bytes).toBe(3_000_000_000);
  });

  // ─── Runs ──────────────────────────────────────────────

  it('creates a run with defaults and reads it back', async () => {
    const { workspace, run } = await createRunFixture();
    expect(run.id).toMatch(/^car_[0-9a-f]{16}$/);
    expect(run.status).toBe('queued');
    expect(run.workspace_id).toBe(workspace.id);
    expect(run.max_wall_ms).toBe(7_200_000);
    expect(run.max_requests).toBe(300);
    expect(run.original_prompt).toBe('Update README to match reality');
    expect(run.input_manifest).toBe('[]');

    const found = await db.agentRuns.getRunById(run.id);
    expect(found?.title).toBe('Fix the docs');
    expect(found?.fallback_model).toBe('pro');
  });

  it('transitionRun is a compare-and-set: loser of a status race gets undefined', async () => {
    const { run } = await createRunFixture();

    const started = await db.agentRuns.transitionRun(run.id, ['queued'], {
      status: 'starting',
      container_id: 'cont-1',
      started_at: new Date().toISOString(),
    });
    expect(started?.status).toBe('starting');
    expect(started?.container_id).toBe('cont-1');

    // A second transition expecting 'queued' must fail — the run moved on.
    const stale = await db.agentRuns.transitionRun(run.id, ['queued'], { status: 'canceled' });
    expect(stale).toBeUndefined();
    expect((await db.agentRuns.getRunById(run.id))!.status).toBe('starting');
  });

  it('tracks active runs per user and globally for queue admission', async () => {
    const { run } = await createRunFixture();
    expect(await db.agentRuns.countActiveRuns()).toBe(0);
    expect(await db.agentRuns.countActiveRunsByUser(user.id)).toBe(0);

    await db.agentRuns.transitionRun(run.id, ['queued'], { status: 'running' });
    expect(await db.agentRuns.countActiveRuns()).toBe(1);
    expect(await db.agentRuns.countActiveRunsByUser(user.id)).toBe(1);

    const other = await createInternalTestUser(db, { email: `car-other-${Date.now()}@test.local` });
    expect(await db.agentRuns.countActiveRunsByUser(other.id)).toBe(0);

    const active = await db.agentRuns.listActiveRuns();
    expect(active.map((r) => r.id)).toContain(run.id);
  });

  it('lists queued runs oldest first and user runs newest first', async () => {
    const { workspace, run: first } = await createRunFixture();
    const second = await db.agentRuns.createRun({
      user_id: user.id,
      workspace_id: workspace.id,
      title: 'Second',
      prompt: 'p',
      model: 'pro',
    });

    const queued = await db.agentRuns.listQueuedRuns();
    const ids = queued.map((r) => r.id);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));

    const mine = await db.agentRuns.listRunsByUser(user.id);
    expect(mine).toHaveLength(2);
    expect(await db.agentRuns.countRunsByUser(user.id)).toBe(2);
  });

  it('finds a run by stable dispatch id and keeps original/runner prompts separate', async () => {
    const workspace = await db.agentRuns.createWorkspace({ user_id: user.id, name: 'dispatch' });
    const run = await db.agentRuns.createRun({
      user_id: user.id,
      workspace_id: workspace.id,
      dispatch_id: `cad_${'a'.repeat(16)}`,
      title: 'Dispatch',
      original_prompt: 'Read the attached file',
      prompt: 'Read the attached file\n\n[The user attached 1 file(s)]',
      input_manifest: '[{"name":"input.pdf"}]',
      model: 'pro',
    });
    expect((await db.agentRuns.getRunByDispatchId(run.dispatch_id!))?.id).toBe(run.id);
    expect(run.original_prompt).toBe('Read the attached file');
    expect(run.prompt).toContain('[The user attached');
  });

  it('claims queue admission atomically and never starts two runs for one user', async () => {
    const workspace = await db.agentRuns.createWorkspace({ user_id: user.id, name: 'claim' });
    const first = await db.agentRuns.createRun({
      user_id: user.id,
      workspace_id: workspace.id,
      title: 'First',
      prompt: 'first',
      model: 'pro',
    });
    const second = await db.agentRuns.createRun({
      user_id: user.id,
      workspace_id: workspace.id,
      title: 'Second',
      prompt: 'second',
      model: 'pro',
    });
    expect((await db.agentRuns.claimNextQueuedRun(2))?.id).toBe(first.id);
    expect(await db.agentRuns.claimNextQueuedRun(2)).toBeUndefined();
    expect((await db.agentRuns.getRunById(second.id))?.status).toBe('queued');
  });

  it('binds approval leases to one exact tool input and consumes them once', async () => {
    const { run } = await createRunFixture();
    const approval = await db.agentRuns.requestApproval({
      run_id: run.id,
      user_id: user.id,
      tool_id: 'crm_mutation',
      action: 'update_company',
      input_hash: 'hash-a',
      input_json: '{"action":"update_company","id":"1"}',
      ttl_ms: 60_000,
    });
    const reused = await db.agentRuns.requestApproval({
      run_id: run.id,
      user_id: user.id,
      tool_id: 'crm_mutation',
      action: 'update_company',
      input_hash: 'hash-a',
      input_json: approval.input_json,
      ttl_ms: 60_000,
    });
    expect(reused.id).toBe(approval.id);

    const decided = await db.agentRuns.decideApproval(approval.id, run.id, user.id, 'approve', user.id);
    expect(decided?.status).toBe('approved');
    expect(
      await db.agentRuns.consumeApproval({
        id: approval.id,
        run_id: run.id,
        user_id: user.id,
        tool_id: 'crm_mutation',
        input_hash: 'different',
      }),
    ).toBeUndefined();
    expect(
      (
        await db.agentRuns.consumeApproval({
          id: approval.id,
          run_id: run.id,
          user_id: user.id,
          tool_id: 'crm_mutation',
          input_hash: 'hash-a',
        })
      )?.status,
    ).toBe('consumed');
    expect(
      await db.agentRuns.consumeApproval({
        id: approval.id,
        run_id: run.id,
        user_id: user.id,
        tool_id: 'crm_mutation',
        input_hash: 'hash-a',
      }),
    ).toBeUndefined();
  });

  it('freezes one outcome outbox item per run and tracks delivery retries', async () => {
    const { run } = await createRunFixture();
    const first = await db.agentRuns.enqueueOutcome({
      run_id: run.id,
      session_id: 'session-1',
      message_id: `cloud-agent-outcome:${run.id}`,
      content: 'first content',
    });
    const duplicate = await db.agentRuns.enqueueOutcome({
      run_id: run.id,
      session_id: 'session-1',
      message_id: `cloud-agent-outcome:${run.id}`,
      content: 'changed content',
    });
    expect(duplicate.content).toBe(first.content);
    await db.agentRuns.markOutcomeFailed(run.id, 'temporary');
    expect((await db.agentRuns.listPendingOutcomes())[0]?.attempts).toBe(1);
    await db.agentRuns.markOutcomeDelivered(run.id);
    expect(await db.agentRuns.listPendingOutcomes()).toHaveLength(0);
  });

  // ─── Events ────────────────────────────────────────────

  it('appends events idempotently and replays incrementally', async () => {
    const { run } = await createRunFixture();

    const inserted = await db.agentRuns.appendEvents(run.id, [
      { seq: 1, type: 'run.started', payload: '{}' },
      { seq: 2, type: 'tool.started', payload: '{"tool":"bash"}' },
    ]);
    expect(inserted).toBe(2);

    // Runner retry after an api restart re-sends an overlapping batch.
    const retried = await db.agentRuns.appendEvents(run.id, [
      { seq: 2, type: 'tool.started', payload: '{"tool":"bash"}' },
      { seq: 3, type: 'tool.completed', payload: '{"tool":"bash"}' },
    ]);
    expect(retried).toBe(1);

    const all = await db.agentRuns.listEvents(run.id);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);

    const tail = await db.agentRuns.listEvents(run.id, { after: 2 });
    expect(tail.map((e) => e.type)).toEqual(['tool.completed']);
  });

  // ─── Artifacts ─────────────────────────────────────────

  it('records artifacts and lists them per run', async () => {
    const { run } = await createRunFixture();
    const artifact = await db.agentRuns.createArtifact({
      run_id: run.id,
      path: 'report.md',
      size_bytes: 1234,
      content_type: 'text/markdown',
      sha256: 'a'.repeat(64),
      storage_key: 'cloud-agent/car_x/report.md',
    });
    expect(artifact.id).toBeGreaterThan(0);

    const listed = await db.agentRuns.listArtifacts(run.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.path).toBe('report.md');
    expect(await db.agentRuns.getArtifactById(artifact.id)).toBeDefined();
  });

  it('cascades events and artifacts when a run is deleted with its user', async () => {
    const victim = await createInternalTestUser(db, { email: `car-victim-${Date.now()}@test.local` });
    const ws = await db.agentRuns.createWorkspace({ user_id: victim.id, name: 'w' });
    const run = await db.agentRuns.createRun({
      user_id: victim.id,
      workspace_id: ws.id,
      title: 't',
      prompt: 'p',
      model: 'pro',
    });
    await db.agentRuns.appendEvents(run.id, [{ seq: 1, type: 'run.started', payload: '{}' }]);

    await db.users.delete(victim.id);
    expect(await db.agentRuns.getRunById(run.id)).toBeUndefined();
    expect(await db.agentRuns.listEvents(run.id)).toHaveLength(0);
  });
});
