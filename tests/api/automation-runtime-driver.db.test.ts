import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type ScheduledTaskRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import {
  createAutomationRuntimeDriver,
  delegateAutomationRuntimeCancel,
  enqueueAutomationRun,
  settleQueuedAutomationCancellation,
} from '../../apps/api/src/scheduler/runtime-driver.js';
import type { RunAgentResult } from '../../apps/api/src/agent-runtime/run-agent.js';
import { createRuntimeDomainProjector } from '../../apps/api/src/runtime/domain-projector.js';
import type { RuntimeEventEnvelope } from '../../apps/api/src/runtime/worker.js';
import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random()}`;
}

async function waitForRunStatus(runId: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await db.runtime.getRun(runId))?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Runtime run ${runId} did not reach ${status}`);
}

async function projectLatestTerminalOutcome(runId: string): Promise<void> {
  const events = await db.runtime.listEvents(runId);
  const terminal = [...events].reverse().find((event) => {
    if (event.type !== 'run.status_changed' && event.type !== 'run.lease_expired') return false;
    const payload = JSON.parse(event.payload) as { result?: { status?: string } };
    return payload.result && ['succeeded', 'failed', 'canceled'].includes(payload.result.status ?? '');
  });
  if (!terminal) throw new Error(`Runtime run ${runId} has no terminal outbox event`);
  await createRuntimeDomainProjector(db)({
    event_id: terminal.id,
    run_id: terminal.run_id,
    step_id: terminal.step_id,
    seq: terminal.seq,
    type: terminal.type,
    payload: JSON.parse(terminal.payload),
    actor_user_id: terminal.actor_user_id,
    created_at: terminal.created_at,
  } satisfies RuntimeEventEnvelope);
}

async function scheduledTask(): Promise<ScheduledTaskRow> {
  const owner = await createInternalTestUser(db, { email: `${unique('automation')}@test.local` });
  return db.scheduledTasks.create({
    user_id: owner.id,
    name: 'Durable market briefing',
    profile_id: 'team',
    task_prompt: 'Prepare the durable market briefing from internal sources.',
    schedule: '0 * * * *',
    timezone: 'UTC',
    max_steps: 5,
  });
}

const result: RunAgentResult = {
  text: 'Durable result',
  usage: { inputTokens: 12, outputTokens: 8 },
  durationMs: 25,
  pipeline: [],
  references: [],
  toolEvidence: [],
  persisted: true,
};

describe('durable Automation Runtime driver', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('executes a queued occurrence after restart from its immutable task snapshot', async () => {
    const task = await scheduledTask();
    const queued = await enqueueAutomationRun({
      db,
      task,
      trigger: 'cron',
      scheduledFor: '2026-08-12T01:00:00.000Z',
    });
    await db.scheduledTasks.update(task.id, {
      name: 'Edited after queue',
      task_prompt: 'This must not replace the admitted execution input.',
    });
    const workerId = unique('automation-worker-after-restart');
    const claimed = await db.runtime.claimNextRun({ worker_id: workerId, lease_ms: 60_000, kinds: ['automation'] });
    expect(claimed?.id).toBe(queued.run.id);
    const executeTask = vi.fn(async () => result);

    await createAutomationRuntimeDriver(
      {},
      { executeTask, heartbeatIntervalMs: 60_000 },
    )({
      db,
      run: claimed!,
      workerId,
      leaseMs: 60_000,
    });
    await projectLatestTerminalOutcome(queued.run.id);

    expect(executeTask).toHaveBeenCalledWith(
      expect.objectContaining({ name: task.name, task_prompt: task.task_prompt }),
      queued.session_id,
      {},
      expect.objectContaining({
        db,
        runtimeRunId: queued.run.id,
        deferLifecycle: true,
        runtimeToolEvidence: expect.objectContaining({
          runId: queued.run.id,
          actorUserId: task.user_id,
          executionAuthority: { mode: 'leased', workerId, leaseMs: 60_000 },
          idempotencyPrefix: expect.stringMatching(/^automation:/),
        }),
      }),
    );
    expect(await db.runtime.getRun(queued.run.id)).toMatchObject({ status: 'succeeded', attempt: 1 });
    expect(JSON.parse((await db.runtime.getRun(queued.run.id))!.output!)).toMatchObject({
      tool_evidence: [],
    });
    expect(await db.runtime.listSteps(queued.run.id)).toEqual([
      expect.objectContaining({ status: 'succeeded', step_key: 'agent-turn', tokens_used: 20, requests_used: 1 }),
    ]);
    expect(await db.sessions.getById(queued.session_id)).toMatchObject({
      id: queued.session_id,
      user_id: task.user_id,
      profile_id: task.profile_id,
      channel: 'task',
    });
    expect((await db.scheduledTasks.getById(task.id))?.last_status).toBe('completed');
  });

  it('rejects a cron snapshot whose definition was disabled or edited before atomic admission', async () => {
    const stale = await scheduledTask();
    await db.scheduledTasks.update(stale.id, {
      enabled: false,
      task_prompt: 'A newly reviewed prompt that supersedes the callback snapshot.',
      notify_webhook: null,
    });

    await expect(
      enqueueAutomationRun({
        db,
        task: stale,
        trigger: 'cron',
        scheduledFor: '2026-08-12T01:30:00.000Z',
      }),
    ).rejects.toThrow(/deleted or changed/);
    expect(await db.runtime.listRunsByOwner(stale.user_id)).toEqual([]);
  });

  it('deduplicates catch-up after the same cron occurrence already succeeded', async () => {
    const task = await scheduledTask();
    const scheduledFor = '2026-08-12T03:00:00.000Z';
    const cron = await enqueueAutomationRun({ db, task, trigger: 'cron', scheduledFor });
    const workerId = 'scheduled-occurrence-worker';
    const first = await db.runtime.claimNextRun({
      worker_id: workerId,
      lease_ms: 60_000,
      kinds: ['automation'],
    });
    expect(first?.id).toBe(cron.run.id);
    const executeTask = vi.fn(async () => result);
    await createAutomationRuntimeDriver(
      {},
      { executeTask, heartbeatIntervalMs: 60_000 },
    )({
      db,
      run: first!,
      workerId,
      leaseMs: 60_000,
    });
    await projectLatestTerminalOutcome(cron.run.id);

    // Domain status/count/timestamps changed after admission, so this also
    // proves replay identity does not depend on volatile task-row fields.
    const updatedTask = (await db.scheduledTasks.getById(task.id))!;
    const catchup = await enqueueAutomationRun({ db, task: updatedTask, trigger: 'catchup', scheduledFor });

    expect(catchup.run.id).toBe(cron.run.id);
    expect(catchup.session_id).toBe(cron.session_id);
    expect(catchup.run.status).toBe('succeeded');
    expect(executeTask).toHaveBeenCalledOnce();
    expect(await db.runtime.listRunsByOwner(task.user_id)).toEqual([
      expect.objectContaining({ id: cron.run.id, source_id: `scheduled:${scheduledFor}` }),
    ]);
    await expect(
      db.runtime.claimNextRun({
        worker_id: 'duplicate-catchup-worker',
        lease_ms: 60_000,
        kinds: ['automation'],
      }),
    ).resolves.toBeUndefined();
  });

  it('fails a stale running turn after its only attempt and never makes it claimable again', async () => {
    const task = await scheduledTask();
    const queued = await enqueueAutomationRun({
      db,
      task,
      trigger: 'manual',
      scheduledFor: '2026-08-12T02:00:00.000Z',
    });
    const base = new Date();
    const claimed = await db.runtime.claimNextRun({
      worker_id: 'automation-crashed-worker',
      lease_ms: 1_000,
      kinds: ['automation'],
      at: base,
    });
    expect(claimed?.id).toBe(queued.run.id);
    const running = await db.runtime.transitionRun({
      id: claimed!.id,
      expected_version: claimed!.version,
      to_status: 'running',
      idempotency_key: 'automation-test-running',
      worker_id: 'automation-crashed-worker',
      lease_ms: 1_000,
    });
    const step = await db.runtime.claimNextStep({
      worker_id: 'automation-crashed-worker',
      lease_ms: 1_000,
      run_id: running.id,
      at: base,
    });
    await db.runtime.transitionStep({
      id: step!.id,
      expected_version: step!.version,
      to_status: 'running',
      idempotency_key: 'automation-test-step-running',
      worker_id: 'automation-crashed-worker',
      lease_ms: 1_000,
    });

    const reclaimed = await db.runtime.reclaimStaleRuns(new Date(base.getTime() + 2_000), 10);
    expect(reclaimed).toEqual([
      expect.objectContaining({ id: queued.run.id, status: 'failed', error_code: 'runtime_attempts_exhausted' }),
    ]);
    await projectLatestTerminalOutcome(queued.run.id);
    expect((await db.scheduledTasks.getById(task.id))?.last_status).toBe('failed');
    expect(await db.runtime.listSteps(queued.run.id)).toEqual([
      expect.objectContaining({ status: 'interrupted', error_code: 'automation_lease_expired' }),
    ]);
    await expect(
      db.runtime.claimNextRun({
        worker_id: 'automation-new-worker',
        lease_ms: 60_000,
        kinds: ['automation'],
        at: new Date(base.getTime() + 3_000),
      }),
    ).resolves.toBeUndefined();
  });

  it('durably cancels a queued occurrence and synchronizes its Step, task and session', async () => {
    const task = await scheduledTask();
    const queued = await enqueueAutomationRun({
      db,
      task,
      trigger: 'manual',
      scheduledFor: '2026-08-12T04:00:00.000Z',
    });
    const fenced = await db.runtime.executeRunDomainCommand(
      {
        type: 'cancel',
        run_id: queued.run.id,
        expected_version: queued.run.version,
        idempotency_key: `cancel-${queued.run.id}`,
      },
      task.user_id,
      ({ run, may_drive: mayDrive }) => delegateAutomationRuntimeCancel(db, run, 'cancel', mayDrive),
    );

    const canceled = await settleQueuedAutomationCancellation(db, fenced.run, task.user_id);
    await projectLatestTerminalOutcome(queued.run.id);

    expect(canceled).toMatchObject({ status: 'canceled', desired_state: 'cancel' });
    expect(await db.runtime.listSteps(canceled.id)).toEqual([expect.objectContaining({ status: 'canceled' })]);
    expect(await db.scheduledTasks.getById(task.id)).toMatchObject({ last_status: 'canceled' });
    expect(await db.sessions.getLatestMessage(queued.session_id)).toMatchObject({
      role: 'assistant',
      content: '任务已取消。',
    });
  });

  it('keeps a running cancel as durable intent until the driver aborts and settles every projection', async () => {
    const task = await scheduledTask();
    const queued = await enqueueAutomationRun({
      db,
      task,
      trigger: 'manual',
      scheduledFor: '2026-08-12T05:00:00.000Z',
    });
    const workerId = unique('automation-cancel-worker');
    const claimed = await db.runtime.claimNextRun({
      worker_id: workerId,
      lease_ms: 60_000,
      kinds: ['automation'],
    });
    const executeTask: typeof import('../../apps/api/src/scheduler/executor.js').executeTaskInSession = vi.fn(
      async (_task, _sessionId, _tools, options): Promise<RunAgentResult> =>
        new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason), { once: true });
        }),
    );
    const driving = createAutomationRuntimeDriver(
      {},
      { executeTask },
    )({
      db,
      run: claimed!,
      workerId,
      leaseMs: 60_000,
    });
    await waitForRunStatus(queued.run.id, 'running');
    const running = (await db.runtime.getRun(queued.run.id))!;
    const fenced = await db.runtime.executeRunDomainCommand(
      {
        type: 'cancel',
        run_id: running.id,
        expected_version: running.version,
        idempotency_key: `cancel-running-${running.id}`,
      },
      task.user_id,
      ({ run, may_drive: mayDrive }) => delegateAutomationRuntimeCancel(db, run, 'cancel', mayDrive),
    );

    expect(await settleQueuedAutomationCancellation(db, fenced.run, task.user_id)).toMatchObject({
      status: 'running',
      desired_state: 'cancel',
    });
    await driving;
    await projectLatestTerminalOutcome(queued.run.id);

    expect(await db.runtime.getRun(queued.run.id)).toMatchObject({ status: 'canceled', desired_state: 'cancel' });
    expect(await db.runtime.listSteps(queued.run.id)).toEqual([expect.objectContaining({ status: 'canceled' })]);
    expect(await db.scheduledTasks.getById(task.id)).toMatchObject({ last_status: 'canceled' });
  });
});
