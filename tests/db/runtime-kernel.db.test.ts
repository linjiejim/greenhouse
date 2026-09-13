/**
 * Trusted Runtime Kernel transactional integration tests.
 *
 * Covers permanent full-payload persistence, idempotency, CAS lifecycle,
 * transactional Event/Outbox writes, interrupts, tools and artifacts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, RuntimeRunRow, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { RuntimePayload } from '@greenhouse/types/runtime';
import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;
let user: UserRow;

function unique(label: string): string {
  return `${label}:${Date.now()}:${Math.random()}`;
}

async function createRun(overrides: Partial<Parameters<DatabaseProvider['runtime']['createRun']>[0]> = {}) {
  return db.runtime.createRun({
    kind: 'mission',
    owner_user_id: user.id,
    initiated_by_user_id: user.id,
    source_kind: 'agent_run',
    source_id: unique('source'),
    idempotency_key: unique('create'),
    input: { prompt: 'prepare the launch brief', exact: { preserve: true } },
    ...overrides,
  });
}

describe('Runtime Kernel service', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    user = await createInternalTestUser(db, { email: `${unique('runtime')}@test.local` });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('creates one canonical run and retains the complete JSON payload without TTL or truncation', async () => {
    const longValue = 'full-payload-'.repeat(5_000);
    const request = {
      kind: 'workflow' as const,
      owner_user_id: user.id,
      initiated_by_user_id: user.id,
      source_kind: 'workflow_run',
      source_id: unique('workflow'),
      idempotency_key: unique('workflow-create'),
      input: { nested: { parameters: [1, true, null, { longValue }] } } as RuntimePayload,
    };
    const first = await db.runtime.createRun(request);
    const duplicate = await db.runtime.createRun(request);

    expect(duplicate.id).toBe(first.id);
    expect(JSON.parse(first.input)).toEqual(request.input);
    expect(first.root_run_id).toBe(first.id);
    expect(first.version).toBe(1);

    const events = await db.runtime.listEvents(first.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ seq: 1, type: 'run.created', idempotency_key: 'run.created' });
    expect(await db.runtime.listOutboxForEvent(events[0]!.id)).toHaveLength(1);

    await expect(db.runtime.createRun({ ...request, input: { nested: { changed: true } } })).rejects.toMatchObject({
      code: 'runtime_idempotency_conflict',
    });
  });

  it('applies a run transition with version CAS and replays the original command result', async () => {
    const run = await createRun();
    const eventKey = unique('run-transition');
    const request = {
      id: run.id,
      expected_version: run.version,
      to_status: 'claimed' as const,
      idempotency_key: eventKey,
      actor_user_id: user.id,
    };
    const transitioned = await db.runtime.transitionRun(request);
    const replayed = await db.runtime.transitionRun(request);

    expect(transitioned).toMatchObject({ status: 'claimed', version: 2 });
    expect(replayed).toEqual(transitioned);
    await expect(
      db.runtime.transitionRun({ ...request, idempotency_key: unique('stale'), to_status: 'canceled' }),
    ).rejects.toMatchObject({ code: 'runtime_version_conflict' });

    const events = await db.runtime.listEvents(run.id);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events[1]).toMatchObject({ type: 'run.status_changed', idempotency_key: eventKey });
    expect(await db.runtime.listOutboxForEvent(events[1]!.id)).toHaveLength(1);
  });

  it('persists and idempotently replays a fenced cross-domain run command', async () => {
    const run = await createRun();
    const claimed = await db.runtime.transitionRun({
      id: run.id,
      expected_version: run.version,
      to_status: 'claimed',
      idempotency_key: unique('domain-command-claimed'),
    });
    const running = await db.runtime.transitionRun({
      id: run.id,
      expected_version: claimed.version,
      to_status: 'running',
      idempotency_key: unique('domain-command-running'),
    });
    const command = {
      type: 'pause' as const,
      run_id: run.id,
      expected_version: running.version,
      idempotency_key: unique('domain-command-pause'),
    };
    let domainEffects = 0;
    const first = await db.runtime.executeRunDomainCommand(command, user.id, async ({ run: locked, may_drive }) => {
      domainEffects += 1;
      expect(locked.version).toBe(running.version);
      expect(may_drive).toBe(true);
    });
    const replayed = await db.runtime.executeRunDomainCommand(command, user.id, async () => {
      domainEffects += 1;
    });

    expect(domainEffects).toBe(1);
    expect(first).toMatchObject({ idempotent: false, run: { desired_state: 'pause', version: running.version + 1 } });
    expect(replayed).toEqual({ run: first.run, idempotent: true });
    await expect(
      db.runtime.executeRunDomainCommand({ ...command, type: 'cancel' }, user.id, async () => {
        domainEffects += 1;
      }),
    ).rejects.toMatchObject({ code: 'runtime_idempotency_conflict' });
    expect(domainEffects).toBe(1);
    const events = await db.runtime.listEvents(run.id);
    expect(events.at(-1)).toMatchObject({ type: 'run.domain_commanded', idempotency_key: command.idempotency_key });
    expect(await db.runtime.listOutboxForEvent(events.at(-1)!.id)).toHaveLength(1);
  });

  it('heartbeats a live run with CAS, lease ownership and an atomic event/outbox record', async () => {
    const run = await createRun();
    const base = new Date();
    const claimed = await db.runtime.claimNextRun({
      worker_id: 'runtime-heartbeat-worker',
      lease_ms: 5_000,
      kinds: ['mission'],
      at: base,
    });
    expect(claimed?.id).toBe(run.id);
    const heartbeatRequest = {
      id: run.id,
      expected_version: claimed!.version,
      worker_id: 'runtime-heartbeat-worker',
      lease_ms: 5_000,
      at: new Date(base.getTime() + 1_000),
    };
    const heartbeat = await db.runtime.heartbeatRun(heartbeatRequest);
    const replayed = await db.runtime.heartbeatRun(heartbeatRequest);

    expect(replayed).toEqual(heartbeat);
    expect(heartbeat).toMatchObject({ version: claimed!.version + 1, lease_owner: 'runtime-heartbeat-worker' });
    await expect(
      db.runtime.heartbeatRun({
        ...heartbeatRequest,
        expected_version: heartbeat.version,
        at: new Date(base.getTime() + 10_000),
      }),
    ).rejects.toMatchObject({ code: 'runtime_lease_lost' });

    const events = await db.runtime.listEvents(run.id);
    expect(events.map((event) => event.type)).toEqual(['run.created', 'run.status_changed', 'run.heartbeat']);
    expect(await db.runtime.listOutboxForEvent(events[2]!.id)).toHaveLength(1);
  });

  it('fences claimed→running on a live matching worker lease for both Run and Step', async () => {
    const run = await createRun();
    const step = await db.runtime.createStep({
      run_id: run.id,
      step_key: 'lease-fenced-start',
      kind: 'agent_turn',
      input: { exact: true },
    });
    const expiredAt = new Date(Date.now() - 10_000);
    const workerId = unique('expired-start-worker');
    const claimedRun = await db.runtime.claimNextRun({
      worker_id: workerId,
      lease_ms: 1_000,
      run_id: run.id,
      at: expiredAt,
    });
    const claimedStep = await db.runtime.claimNextStep({
      worker_id: workerId,
      lease_ms: 1_000,
      run_id: run.id,
      step_id: step.id,
      at: expiredAt,
    });

    await expect(
      db.runtime.transitionRun({
        id: run.id,
        expected_version: claimedRun!.version,
        to_status: 'running',
        idempotency_key: unique('expired-run-start'),
        worker_id: workerId,
        lease_ms: 30_000,
      }),
    ).rejects.toMatchObject({ code: 'runtime_lease_lost' });
    await expect(
      db.runtime.transitionStep({
        id: step.id,
        expected_version: claimedStep!.version,
        to_status: 'running',
        idempotency_key: unique('expired-step-start'),
        worker_id: workerId,
        lease_ms: 30_000,
      }),
    ).rejects.toMatchObject({ code: 'runtime_lease_lost' });
  });

  it('atomically admits a live ToolCall only while its Run and Step leases remain authoritative', async () => {
    const run = await createRun({ kind: 'automation' });
    const step = await db.runtime.createStep({
      run_id: run.id,
      step_key: 'tool-authority',
      kind: 'automation_agent_turn',
      input: { exact: true },
    });
    const workerId = unique('tool-worker');
    const claimed = await db.runtime.claimExecution({
      run_id: run.id,
      step_id: step.id,
      worker_id: workerId,
      lease_ms: 60_000,
    });
    await db.runtime.transitionRun({
      id: run.id,
      expected_version: claimed!.run.version,
      to_status: 'running',
      idempotency_key: unique('tool-run-running'),
      worker_id: workerId,
      lease_ms: 60_000,
    });
    await db.runtime.transitionStep({
      id: step.id,
      expected_version: claimed!.step.version,
      to_status: 'running',
      idempotency_key: unique('tool-step-running'),
      worker_id: workerId,
      lease_ms: 60_000,
    });
    const request = {
      run_id: run.id,
      step_id: step.id,
      tool_name: 'project_query',
      input: { nested: { complete: 'payload' } },
      canonical_input_hash: 'sha256:tool-authority',
      risk_level: 'r0' as const,
      idempotency_key: unique('tool-authority'),
      actor_user_id: user.id,
      worker_id: workerId,
      lease_ms: 60_000,
    };

    const tool = await db.runtime.beginToolCallWithAuthority(request);

    expect(tool).toMatchObject({ status: 'running', run_id: run.id, step_id: step.id, version: 2 });
    expect(JSON.parse(tool.input)).toEqual(request.input);
    await expect(db.runtime.beginToolCallWithAuthority(request)).rejects.toMatchObject({
      code: 'runtime_idempotency_conflict',
    });
    expect((await db.runtime.listEvents(run.id)).slice(-2).map((event) => event.type)).toEqual([
      'tool.requested',
      'tool.status_changed',
    ]);
  });

  it.each(['canceled', 'expired'] as const)(
    'rejects a ToolCall before persistence when leased execution is already %s',
    async (reason) => {
      const run = await createRun({ kind: 'subagent' });
      const step = await db.runtime.createStep({
        run_id: run.id,
        step_key: `tool-${reason}`,
        kind: 'subagent_turn',
        input: { exact: true },
      });
      const workerId = unique(`tool-${reason}-worker`);
      const claimed = await db.runtime.claimExecution({
        run_id: run.id,
        step_id: step.id,
        worker_id: workerId,
        lease_ms: 60_000,
      });
      const running = await db.runtime.transitionRun({
        id: run.id,
        expected_version: claimed!.run.version,
        to_status: 'running',
        idempotency_key: unique(`tool-${reason}-run-running`),
        worker_id: workerId,
        lease_ms: 60_000,
      });
      await db.runtime.transitionStep({
        id: step.id,
        expected_version: claimed!.step.version,
        to_status: 'running',
        idempotency_key: unique(`tool-${reason}-step-running`),
        worker_id: workerId,
        lease_ms: 60_000,
      });
      if (reason === 'canceled') {
        await db.runtime.executeRunDomainCommand(
          {
            type: 'cancel',
            run_id: run.id,
            expected_version: running.version,
            idempotency_key: unique('tool-cancel-command'),
          },
          user.id,
          async ({ may_drive: mayDrive }) => expect(mayDrive).toBe(true),
        );
      }

      await expect(
        db.runtime.beginToolCallWithAuthority({
          run_id: run.id,
          step_id: step.id,
          tool_name: 'crm_mutation',
          input: { exact: reason },
          canonical_input_hash: `sha256:${reason}`,
          risk_level: 'r2',
          idempotency_key: unique(`tool-${reason}`),
          actor_user_id: user.id,
          worker_id: workerId,
          lease_ms: 60_000,
          ...(reason === 'expired' ? { at: new Date(Date.now() + 120_000) } : {}),
        }),
      ).rejects.toMatchObject({ code: 'runtime_lease_lost' });
      expect(await db.runtime.listToolCalls(run.id)).toEqual([]);
    },
  );

  it('admits only an unleased running Chat projection through the projection authority path', async () => {
    const admitted = await db.runtime.admitChatTrace({
      owner_user_id: user.id,
      initiated_by_user_id: user.id,
      session_id: null,
      source_id: unique('chat-tool-trace'),
      input: { transcript: 'complete' },
      actor_user_id: user.id,
    });
    const claimedRun = await db.runtime.transitionRun({
      id: admitted.run.id,
      expected_version: admitted.run.version,
      to_status: 'claimed',
      idempotency_key: unique('chat-tool-run-claimed'),
    });
    await db.runtime.transitionRun({
      id: admitted.run.id,
      expected_version: claimedRun.version,
      to_status: 'running',
      projection_only: true,
      idempotency_key: unique('chat-tool-run-running'),
    });
    const claimedStep = await db.runtime.transitionStep({
      id: admitted.step.id,
      expected_version: admitted.step.version,
      to_status: 'claimed',
      idempotency_key: unique('chat-tool-step-claimed'),
    });
    await db.runtime.transitionStep({
      id: admitted.step.id,
      expected_version: claimedStep.version,
      to_status: 'running',
      projection_only: true,
      idempotency_key: unique('chat-tool-step-running'),
    });

    const tool = await db.runtime.beginToolCallWithAuthority({
      run_id: admitted.run.id,
      step_id: admitted.step.id,
      tool_name: 'memory',
      input: { action: 'search', query: 'exact' },
      canonical_input_hash: 'sha256:chat-tool',
      risk_level: 'r1',
      idempotency_key: unique('chat-tool'),
      actor_user_id: user.id,
      projection_only: true,
    });

    expect(tool).toMatchObject({ status: 'running', run_id: admitted.run.id, step_id: admitted.step.id });
  });

  it('heartbeats and requeues a stale step as a new immutable attempt at an explicit safe checkpoint', async () => {
    const run = await createRun();
    const base = new Date();
    const claimedRun = await db.runtime.claimNextRun({
      worker_id: 'runtime-run-worker',
      lease_ms: 60_000,
      kinds: ['mission'],
      at: base,
    });
    const running = await db.runtime.transitionRun({
      id: run.id,
      expected_version: claimedRun!.version,
      to_status: 'running',
      idempotency_key: unique('run-running'),
    });
    expect(running.status).toBe('running');
    const step = await db.runtime.createStep({
      run_id: run.id,
      step_key: 'safe-retry-step',
      kind: 'mission_checkpoint',
      input: { full: { parameters: ['keep', 'everything'] } },
    });
    const claimedStep = await db.runtime.claimNextStep({
      worker_id: 'runtime-run-worker',
      lease_ms: 5_000,
      run_id: run.id,
      at: base,
    });
    expect(claimedStep?.id).toBe(step.id);
    const heartbeat = await db.runtime.heartbeatStep({
      id: step.id,
      expected_version: claimedStep!.version,
      worker_id: 'runtime-run-worker',
      lease_ms: 5_000,
      at: new Date(base.getTime() + 1_000),
    });
    const staleAt = new Date(base.getTime() + 7_000);
    expect((await db.runtime.listStaleSteps(staleAt)).map((row) => row.id)).toContain(step.id);

    const request = {
      id: step.id,
      expected_version: heartbeat.version,
      idempotency_key: unique('stale-requeue'),
      checkpoint: { journal_seq: 42, external_writes: 'none' } as const,
      at: staleAt,
    };
    const result = await db.runtime.requeueStaleStep(request);
    const replayed = await db.runtime.requeueStaleStep(request);

    expect(replayed).toEqual(result);
    expect(result.interrupted).toMatchObject({ id: step.id, status: 'interrupted', attempt: 1 });
    expect(result.replacement).toMatchObject({ status: 'queued', attempt: 2, step_key: step.step_key });
    expect(result.replacement.id).not.toBe(step.id);
    expect(result.replacement.input).toBe(step.input);
    const events = await db.runtime.listEvents(run.id);
    expect(events.slice(-2).map((event) => event.type)).toEqual(['step.status_changed', 'step.created']);
    expect(await db.runtime.listOutboxForEvent(events.at(-1)!.id)).toHaveLength(1);
  });

  it('reclaims pre-running claims safely but never replays a stale running attempt', async () => {
    const run = await db.runtime.createRun({
      kind: 'automation',
      owner_user_id: user.id,
      initiated_by_user_id: user.id,
      source_kind: unique('scheduled-task'),
      source_id: unique('occurrence'),
      max_attempts: 1,
      input: { exact: true },
    });
    const base = new Date();
    const firstClaim = await db.runtime.claimNextRun({
      worker_id: unique('worker-a'),
      lease_ms: 1_000,
      kinds: ['automation'],
      at: base,
    });
    expect(firstClaim).toMatchObject({ id: run.id, status: 'claimed', attempt: 1 });

    const [safelyRequeued] = await db.runtime.reclaimStaleRuns(new Date(base.getTime() + 1_001));
    expect(safelyRequeued).toMatchObject({
      id: run.id,
      status: 'queued',
      attempt: 1,
      error_code: 'runtime_claim_recovered',
    });
    const secondClaim = await db.runtime.claimNextRun({
      worker_id: 'worker-b',
      lease_ms: 1_000,
      kinds: ['automation'],
      at: new Date(base.getTime() + 2_000),
    });
    expect(secondClaim).toMatchObject({ id: run.id, status: 'claimed', attempt: 2, error_code: null });
    const running = await db.runtime.transitionRun({
      id: run.id,
      expected_version: secondClaim!.version,
      to_status: 'running',
      idempotency_key: unique('running'),
      worker_id: 'worker-b',
      lease_ms: 1_000,
    });

    const [failed] = await db.runtime.reclaimStaleRuns(new Date(base.getTime() + 3_001));
    expect(failed).toMatchObject({
      id: run.id,
      status: 'failed',
      attempt: 2,
      error_code: 'runtime_attempts_exhausted',
    });
    expect(running.status).toBe('running');
  });

  it('settles an expired leased cancellation as canceled instead of failed', async () => {
    const run = await db.runtime.createRun({
      kind: 'subagent',
      owner_user_id: user.id,
      initiated_by_user_id: user.id,
      source_kind: 'spawned_session',
      source_id: unique('child'),
      max_attempts: 1,
      input: { exact: true },
    });
    const base = new Date();
    const claimed = await db.runtime.claimNextRun({
      worker_id: unique('cancel-worker'),
      lease_ms: 1_000,
      kinds: ['subagent'],
      at: base,
    });
    await db.runtime.executeRunDomainCommand(
      {
        type: 'cancel',
        run_id: run.id,
        expected_version: claimed!.version,
        idempotency_key: unique('cancel-command'),
      },
      user.id,
      async ({ may_drive: mayDrive }) => expect(mayDrive).toBe(true),
    );

    const [canceled] = await db.runtime.reclaimStaleRuns(new Date(base.getTime() + 1_001));
    expect(canceled).toMatchObject({
      id: run.id,
      status: 'canceled',
      desired_state: 'cancel',
      error_code: 'runtime_cancel_requested',
    });
  });

  it('lets a live worker atomically request and settle cancellation', async () => {
    const run = await db.runtime.createRun({
      kind: 'automation',
      owner_user_id: user.id,
      initiated_by_user_id: user.id,
      source_kind: unique('scheduled-task'),
      source_id: unique('occurrence'),
      max_attempts: 1,
      input: { exact: true },
    });
    const workerId = unique('atomic-cancel-worker');
    const claimed = await db.runtime.claimNextRun({
      worker_id: workerId,
      lease_ms: 60_000,
      run_id: run.id,
    });

    const canceled = await db.runtime.transitionRun({
      id: run.id,
      expected_version: claimed!.version,
      to_status: 'canceled',
      desired_state: 'cancel',
      idempotency_key: unique('atomic-cancel'),
      worker_id: workerId,
      lease_ms: 60_000,
    });

    expect(canceled).toMatchObject({
      id: run.id,
      status: 'canceled',
      desired_state: 'cancel',
      lease_owner: null,
      lease_expires_at: null,
    });
  });

  it('bounds pre-running claim recovery instead of cycling an unhealthy worker forever', async () => {
    const run = await db.runtime.createRun({
      kind: 'automation',
      owner_user_id: user.id,
      initiated_by_user_id: user.id,
      source_kind: unique('scheduled-task'),
      source_id: unique('occurrence'),
      max_attempts: 1,
      input: { exact: true },
    });
    const base = new Date();
    await db.runtime.claimNextRun({
      worker_id: unique('worker-a'),
      lease_ms: 1_000,
      kinds: ['automation'],
      at: base,
    });
    const [requeued] = await db.runtime.reclaimStaleRuns(new Date(base.getTime() + 1_001));
    expect(requeued).toMatchObject({ id: run.id, status: 'queued', attempt: 1 });

    await db.runtime.claimNextRun({
      worker_id: unique('worker-b'),
      lease_ms: 1_000,
      kinds: ['automation'],
      at: new Date(base.getTime() + 2_000),
    });
    const [failed] = await db.runtime.reclaimStaleRuns(new Date(base.getTime() + 3_001));
    expect(failed).toMatchObject({
      id: run.id,
      status: 'failed',
      attempt: 2,
      error_code: 'runtime_attempts_exhausted',
    });
  });

  it('persists step, tool, artifact and exact human interrupt decisions on one timeline', async () => {
    const run = await createRun();
    const claimed = await db.runtime.transitionRun({
      id: run.id,
      expected_version: run.version,
      to_status: 'claimed',
      idempotency_key: unique('claim'),
    });
    await db.runtime.transitionRun({
      id: run.id,
      expected_version: claimed.version,
      to_status: 'running',
      idempotency_key: unique('running'),
    });

    const step = await db.runtime.createStep({
      run_id: run.id,
      step_key: 'write-crm-note',
      kind: 'agent_turn',
      input: { customer_id: 'customer-42', note: 'exact content' },
    });
    const tool = await db.runtime.createToolCall({
      run_id: run.id,
      step_id: step.id,
      tool_name: 'crm_mutation',
      input: { customer_id: 'customer-42', note: 'exact content' },
      canonical_input_hash: 'sha256:exact',
      risk_level: 'r1',
      idempotency_key: unique('tool'),
    });
    const interrupt = await db.runtime.createInterrupt({
      run_id: run.id,
      step_id: step.id,
      tool_call_id: tool.id,
      kind: 'mutation_approval',
      payload: { preview: { customer_id: 'customer-42', note: 'exact content' } },
      canonical_input_hash: tool.canonical_input_hash,
      risk_level: 'r1',
      assignee_user_id: user.id,
    });
    const resolved = await db.runtime.commandInterrupt(
      {
        type: 'resolve',
        interrupt_id: interrupt.id,
        expected_version: interrupt.version,
        idempotency_key: unique('approve'),
        decision: { approved: true, note: 'reviewed exactly' },
      },
      user.id,
    );
    const artifact = await db.runtime.createArtifact({
      run_id: run.id,
      step_id: step.id,
      tool_call_id: tool.id,
      direction: 'output',
      kind: 'document',
      name: 'launch-brief.md',
      path: 'artifacts/launch-brief.md',
      source: 'sandbox-runner',
    });
    const available = await db.runtime.transitionArtifact({
      id: artifact.id,
      expected_status: 'pending',
      to_status: 'available',
      idempotency_key: unique('artifact-available'),
      storage_key: 'runtime/artifacts/launch-brief.md',
      sha256: 'abc123',
      size_bytes: 321,
    });

    expect(resolved).toMatchObject({ status: 'resolved', decided_by_user_id: user.id });
    expect(JSON.parse(resolved.decision!)).toEqual({ approved: true, note: 'reviewed exactly' });
    expect(available).toMatchObject({ status: 'available', size_bytes: 321, sha256: 'abc123' });
    const timeline = await db.runtime.listEvents(run.id);
    expect(timeline.map((event) => event.type)).toEqual([
      'run.created',
      'run.status_changed',
      'run.status_changed',
      'step.created',
      'tool.requested',
      'interrupt.created',
      'interrupt.status_changed',
      'artifact.created',
      'artifact.status_changed',
    ]);
    expect(timeline.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('rejects cross-run step/tool references and idempotently creates artifacts and interrupts', async () => {
    const left = await createRun();
    const right = await createRun();
    const step = await db.runtime.createStep({
      run_id: left.id,
      step_key: 'left-only',
      kind: 'agent_turn',
      input: { exact: true },
    });
    await expect(
      db.runtime.createToolCall({
        run_id: right.id,
        step_id: step.id,
        tool_name: 'crm_mutation',
        input: { exact: true },
        canonical_input_hash: 'sha256:left-only',
        risk_level: 'r1',
      }),
    ).rejects.toMatchObject({ code: 'runtime_invalid_input' });

    const artifactRequest = {
      run_id: left.id,
      step_id: step.id,
      direction: 'output' as const,
      kind: 'document',
      name: 'exact.md',
      source: 'sandbox-runner',
      idempotency_key: unique('artifact-create'),
    };
    const artifact = await db.runtime.createArtifact(artifactRequest);
    expect(await db.runtime.createArtifact(artifactRequest)).toEqual(artifact);

    const tool = await db.runtime.createToolCall({
      run_id: left.id,
      step_id: step.id,
      tool_name: 'crm_mutation',
      input: { exact: true },
      canonical_input_hash: 'sha256:exact',
      risk_level: 'r1',
      idempotency_key: unique('tool-create'),
    });
    const interruptRequest = {
      run_id: left.id,
      step_id: step.id,
      tool_call_id: tool.id,
      kind: 'mutation_approval' as const,
      payload: { exact: { parameters: ['all', 'retained'] } },
      assignee_user_id: user.id,
      idempotency_key: unique('interrupt-create'),
    };
    const interrupt = await db.runtime.createInterrupt(interruptRequest);
    expect(await db.runtime.createInterrupt(interruptRequest)).toEqual(interrupt);
    await expect(
      db.runtime.createArtifact({ ...artifactRequest, run_id: right.id, tool_call_id: tool.id }),
    ).rejects.toMatchObject({ code: 'runtime_invalid_input' });
    expect((await db.runtime.listSteps(left.id)).map((row) => row.id)).toContain(step.id);
    expect((await db.runtime.listToolCalls(left.id)).map((row) => row.id)).toContain(tool.id);
    expect((await db.runtime.listArtifacts(left.id)).map((row) => row.id)).toContain(artifact.id);
    expect((await db.runtime.listInterrupts(left.id)).map((row) => row.id)).toContain(interrupt.id);
    expect(await db.runtime.getToolCall(tool.id)).toMatchObject({
      id: tool.id,
      interrupt_id: interrupt.id,
      version: 2,
    });
    expect(await db.runtime.getArtifact(artifact.id)).toEqual(artifact);
    expect(await db.runtime.getInterrupt(interrupt.id)).toEqual(interrupt);
  });

  it('expires pending interrupts with CAS event/outbox state while retaining their exact payload', async () => {
    const run = await createRun();
    const at = new Date();
    const interrupt = await db.runtime.createInterrupt({
      run_id: run.id,
      kind: 'external_dependency',
      payload: { dependency: { full_request: 'do not truncate', parameters: [1, 2, 3] } },
      assignee_user_id: user.id,
      expires_at: new Date(at.getTime() - 1_000).toISOString(),
    });
    const expired = await db.runtime.expireInterrupts(at);

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ id: interrupt.id, status: 'expired', version: interrupt.version + 1 });
    expect(JSON.parse(expired[0]!.payload)).toEqual({
      dependency: { full_request: 'do not truncate', parameters: [1, 2, 3] },
    });
    const events = await db.runtime.listEvents(run.id);
    expect(events.at(-1)?.type).toBe('interrupt.status_changed');
    expect(await db.runtime.listOutboxForEvent(events.at(-1)!.id)).toHaveLength(1);
  });

  it('leases, fails, retries and acknowledges outbox delivery without changing the run result', async () => {
    const run = await createRun();
    const topic = unique('delivery-topic');
    await db.runtime.appendEvent({
      run_id: run.id,
      type: 'test.delivery',
      payload: { exact: { body: 'permanent' } },
      idempotency_key: unique('delivery-event'),
      topics: [topic],
      max_attempts: 3,
    });
    const [claimed] = await db.runtime.claimOutbox({ worker_id: 'delivery-a', lease_ms: 60_000, topics: [topic] });
    expect(claimed).toMatchObject({ status: 'claimed', attempts: 1, lease_owner: 'delivery-a' });

    const failed = await db.runtime.failOutbox({
      id: claimed!.id,
      expected_version: claimed!.version,
      worker_id: 'delivery-a',
      error: 'temporary downstream outage',
    });
    expect(failed.status).toBe('failed');
    const retried = await db.runtime.retryOutbox({
      id: failed.id,
      expected_version: failed.version,
      available_at: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(retried.status).toBe('pending');
    const [reclaimed] = await db.runtime.claimOutbox({ worker_id: 'delivery-b', lease_ms: 60_000, topics: [topic] });
    const delivered = await db.runtime.acknowledgeOutbox({
      id: reclaimed!.id,
      expected_version: reclaimed!.version,
      worker_id: 'delivery-b',
    });
    expect(delivered).toMatchObject({ status: 'delivered', attempts: 2, lease_owner: null });
    expect((await db.runtime.getRun(run.id))?.status).toBe('queued');

    const expiredTopic = unique('expired-delivery-topic');
    await db.runtime.appendEvent({
      run_id: run.id,
      type: 'test.expired-delivery',
      payload: { exact: true },
      idempotency_key: unique('expired-delivery-event'),
      topics: [expiredTopic],
    });
    const leaseStart = new Date();
    const [expiredClaim] = await db.runtime.claimOutbox({
      worker_id: 'delivery-expired',
      lease_ms: 1_000,
      topics: [expiredTopic],
      at: leaseStart,
    });
    await expect(
      db.runtime.acknowledgeOutbox({
        id: expiredClaim!.id,
        expected_version: expiredClaim!.version,
        worker_id: 'delivery-expired',
        at: new Date(leaseStart.getTime() + 1_001),
      }),
    ).rejects.toMatchObject({ code: 'runtime_lease_lost' });
  });

  it('stores parent/root lineage without coupling it to another domain lifecycle', async () => {
    const root = await createRun({ kind: 'workflow' });
    const child = await createRun({
      kind: 'subagent',
      parent_run_id: root.id,
      source_kind: 'subagent_session',
      source_id: unique('child-source'),
      idempotency_key: unique('child-create'),
    });
    expect(child).toMatchObject({ parent_run_id: root.id, root_run_id: root.id });
  });

  it('lists runs with stable descending keyset pagination and returns one aggregated detail view', async () => {
    const created: RuntimeRunRow[] = [];
    for (let index = 0; index < 3; index += 1) {
      created.push(
        await createRun({
          id: `runtime-list-${Date.now()}-${index}`,
          kind: index === 1 ? 'workflow' : 'mission',
        }),
      );
    }
    const first = await db.runtime.listRuns({ owner_user_id: user.id, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();
    const second = await db.runtime.listRuns({
      owner_user_id: user.id,
      cursor: first.next_cursor!,
      limit: 2,
    });
    const returned = [...first.items, ...second.items].filter((row) => created.some((item) => item.id === row.id));
    expect(new Set(returned.map((row) => row.id))).toEqual(new Set(created.map((row) => row.id)));
    expect(returned).toHaveLength(3);
    const missionOnly = await db.runtime.listRuns({ owner_user_id: user.id, kinds: ['mission'], limit: 100 });
    expect(missionOnly.items.filter((row) => created.some((item) => item.id === row.id))).toHaveLength(2);

    const detail = await db.runtime.getRunDetail(created[0]!.id);
    expect(detail?.run.id).toBe(created[0]!.id);
    expect(detail?.events.map((event) => event.type)).toEqual(['run.created']);
    expect(detail?.steps).toEqual([]);
    expect(await db.runtime.getRunDetail('runtime-missing')).toBeUndefined();
  });
});
