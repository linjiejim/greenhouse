/**
 * Runtime Kernel cross-connection concurrency tests.
 *
 * @db-commit-reason SKIP LOCKED claims, per-run sequence allocation and CAS
 * races require independently committed PostgreSQL connections; a single
 * rollback-wrapped transaction cannot prove these guarantees.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, RuntimeKernelError, ScheduledTaskActiveRunError } from '@greenhouse/db';
import type { DatabaseProvider, RuntimeRunRow } from '@greenhouse/db';
import { cleanupRuntimeTestRun, TEST_DATABASE_URL } from '@greenhouse/db/test-config';

let db: DatabaseProvider;
const runIds = new Set<string>();
/** Committed fixtures outlive this file; anything it commits is removed by id. */
const userIds = new Set<string>();

async function createRun(): Promise<RuntimeRunRow> {
  const token = randomUUID();
  const run = await db.runtime.createRun({
    kind: 'mission',
    owner_user_id: `runtime-race-user-${token}`,
    initiated_by_user_id: `runtime-race-user-${token}`,
    source_kind: 'agent_run',
    source_id: `runtime-race-source-${token}`,
    idempotency_key: `runtime-race-create-${token}`,
    input: { token },
  });
  runIds.add(run.id);
  return run;
}

describe('Runtime Kernel concurrency', () => {
  beforeAll(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    for (const runId of runIds) await cleanupRuntimeTestRun(db, runId);
    runIds.clear();
    for (const userId of userIds) await db.users.delete(userId);
    userIds.clear();
  });

  afterAll(async () => {
    await db.close();
    _resetProvider();
  });

  it('allows exactly one worker to claim a queued run', async () => {
    const run = await createRun();
    const results = await Promise.all([
      db.runtime.claimNextRun({ worker_id: `worker-a-${randomUUID()}`, lease_ms: 60_000, kinds: ['mission'] }),
      db.runtime.claimNextRun({ worker_id: `worker-b-${randomUUID()}`, lease_ms: 60_000, kinds: ['mission'] }),
    ]);
    expect(results.filter((row) => row?.id === run.id)).toHaveLength(1);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.runtime.getRun(run.id)).toMatchObject({ status: 'claimed', attempt: 1, version: 2 });
  });

  it('admits only one active occurrence for a single-source Automation', async () => {
    const owner = `automation-owner-${randomUUID()}`;
    const sourceKind = `scheduled_task:${randomUUID()}`;
    const request = (suffix: string) =>
      db.runtime.createRun({
        kind: 'automation',
        owner_user_id: owner,
        initiated_by_user_id: owner,
        source_kind: sourceKind,
        source_id: `manual:${suffix}`,
        idempotency_key: `automation:${suffix}`,
        single_active_source_kind: true,
        max_attempts: 1,
        input: { suffix },
      });
    const results = await Promise.allSettled([request('left'), request('right')]);
    const accepted = results.find(
      (result): result is PromiseFulfilledResult<RuntimeRunRow> => result.status === 'fulfilled',
    );
    expect(accepted).toBeDefined();
    runIds.add(accepted!.value.id);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'runtime_invalid_transition' },
    });
  });

  it('serializes Automation admission against deleting its task definition', async () => {
    const token = randomUUID();
    const owner = await db.users.create({
      email: `automation-admit-delete-${token}@test.local`,
      nickname: 'Automation admission race',
      role: 'team',
      password_hash: 'test-only',
    });
    userIds.add(owner.id);
    const task = await db.scheduledTasks.create({
      user_id: owner.id,
      name: 'Admission/delete race',
      profile_id: 'team',
      task_prompt: 'Prove that deletion and durable admission share one lock.',
      schedule: '0 * * * *',
    });
    const runId = `rta_${token.replaceAll('-', '')}`;
    const admission = db.scheduledTasks.admitRuntimeOccurrence({
      task_id: task.id,
      expected_user_id: task.user_id,
      expected_profile_id: task.profile_id,
      expected_definition: {
        name: task.name,
        task_prompt: task.task_prompt,
        schedule: task.schedule,
        timezone: task.timezone,
        enabled: task.enabled,
        max_steps: task.max_steps,
        notify_webhook: task.notify_webhook,
        notify_email: task.notify_email,
        notify_wecom: task.notify_wecom,
      },
      run: {
        id: runId,
        kind: 'automation',
        owner_user_id: task.user_id,
        initiated_by_user_id: task.user_id,
        source_kind: `scheduled_task:${task.id}`,
        source_id: `manual:${token}`,
        idempotency_key: `automation-admit-delete:${token}`,
        single_active_source_kind: true,
        max_attempts: 1,
        input: { token },
      },
      step: {
        step_key: 'agent-turn',
        kind: 'automation_agent_turn',
        input: { token },
      },
    });
    const deletion = db.scheduledTasks.delete(task.id);
    const [admitted, deleted] = await Promise.allSettled([admission, deletion]);

    if (admitted.status === 'fulfilled') {
      runIds.add(admitted.value.run.id);
      expect(deleted).toMatchObject({
        status: 'rejected',
        reason: expect.any(ScheduledTaskActiveRunError),
      });
      expect(await db.scheduledTasks.getById(task.id)).toBeDefined();
    } else {
      expect(deleted).toMatchObject({ status: 'fulfilled', value: true });
      expect(admitted.reason).toMatchObject({ name: 'ScheduledTaskAdmissionError' });
      expect(await db.runtime.getRun(runId)).toBeUndefined();
    }
  });

  it('lets only one same-version transition win across connections', async () => {
    const run = await createRun();
    const claimed = await db.runtime.claimNextRun({ worker_id: 'cas-owner', lease_ms: 60_000, kinds: ['mission'] });
    expect(claimed?.id).toBe(run.id);
    const transition = (suffix: string) =>
      db.runtime.transitionRun({
        id: run.id,
        expected_version: claimed!.version,
        to_status: 'running',
        idempotency_key: `cas-${suffix}-${randomUUID()}`,
      });
    const results = await Promise.allSettled([transition('left'), transition('right')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'runtime_version_conflict' },
    });
    expect(await db.runtime.getRun(run.id)).toMatchObject({ status: 'running', version: 3 });
  });

  it('holds the persistent run fence across domain effects so same-version pause and cancel cannot both drive', async () => {
    const run = await createRun();
    const claimed = await db.runtime.claimNextRun({
      worker_id: `command-owner-${randomUUID()}`,
      lease_ms: 60_000,
      kinds: ['mission'],
    });
    const running = await db.runtime.transitionRun({
      id: run.id,
      expected_version: claimed!.version,
      to_status: 'running',
      idempotency_key: `command-running-${randomUUID()}`,
    });

    let releasePause!: () => void;
    const pauseHold = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
    let markPauseEntered!: () => void;
    const pauseEntered = new Promise<void>((resolve) => {
      markPauseEntered = resolve;
    });
    const effects: Array<{ command: 'pause' | 'cancel'; mayDrive: boolean }> = [];

    const pause = db.runtime.executeRunDomainCommand(
      {
        type: 'pause',
        run_id: run.id,
        expected_version: running.version,
        idempotency_key: `domain-pause-${randomUUID()}`,
      },
      run.owner_user_id,
      async ({ may_drive: mayDrive }) => {
        effects.push({ command: 'pause', mayDrive });
        markPauseEntered();
        await pauseHold;
      },
    );
    await pauseEntered;
    const cancel = db.runtime.executeRunDomainCommand(
      {
        type: 'cancel',
        run_id: run.id,
        expected_version: running.version,
        idempotency_key: `domain-cancel-${randomUUID()}`,
      },
      run.owner_user_id,
      async ({ may_drive: mayDrive }) => {
        effects.push({ command: 'cancel', mayDrive });
        if (!mayDrive) {
          throw new RuntimeKernelError('runtime_version_conflict', `Runtime run ${run.id} changed concurrently`);
        }
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    releasePause();

    const results = await Promise.allSettled([pause, cancel]);
    expect(results[0]).toMatchObject({ status: 'fulfilled' });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'runtime_version_conflict' } });
    expect(effects).toEqual([
      { command: 'pause', mayDrive: true },
      { command: 'cancel', mayDrive: false },
    ]);
    expect(await db.runtime.getRun(run.id)).toMatchObject({
      status: 'running',
      desired_state: 'pause',
      version: running.version + 1,
    });
    const events = await db.runtime.listEvents(run.id);
    expect(events.filter((event) => event.type === 'run.domain_commanded')).toHaveLength(1);
  });

  it('claims one step once and lets only one stale-attempt requeue win', async () => {
    const run = await createRun();
    const base = new Date();
    const executionWorker = `run-owner-${randomUUID()}`;
    const claimedRun = await db.runtime.claimNextRun({
      worker_id: executionWorker,
      lease_ms: 60_000,
      kinds: ['mission'],
      at: base,
    });
    await db.runtime.transitionRun({
      id: run.id,
      expected_version: claimedRun!.version,
      to_status: 'running',
      idempotency_key: `running-${randomUUID()}`,
      worker_id: executionWorker,
      lease_ms: 60_000,
    });
    const step = await db.runtime.createStep({
      run_id: run.id,
      step_key: 'concurrent-step',
      kind: 'safe-checkpoint',
      input: { permanent: true },
    });
    const claims = await Promise.all([
      db.runtime.claimNextStep({
        worker_id: executionWorker,
        lease_ms: 1_000,
        run_id: run.id,
        at: base,
      }),
      db.runtime.claimNextStep({
        worker_id: executionWorker,
        lease_ms: 1_000,
        run_id: run.id,
        at: base,
      }),
    ]);
    expect(claims.filter((row) => row?.id === step.id)).toHaveLength(1);
    const claimedStep = claims.find((row) => row?.id === step.id)!;
    const requeue = (side: string) =>
      db.runtime.requeueStaleStep({
        id: step.id,
        expected_version: claimedStep.version,
        idempotency_key: `requeue-${side}-${randomUUID()}`,
        checkpoint: { side, external_writes: 'none' },
        at: new Date(base.getTime() + 1_001),
      });
    const results = await Promise.allSettled([requeue('left'), requeue('right')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'runtime_version_conflict' },
    });
    const events = await db.runtime.listEvents(run.id);
    expect(events.filter((event) => event.type === 'step.status_changed')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'step.created')).toHaveLength(2);
  });

  it('serializes event sequence allocation and preserves both events', async () => {
    const run = await createRun();
    const sides = Array.from({ length: 12 }, (_, index) => `side-${index}`);
    await Promise.all(
      sides.map((side) =>
        db.runtime.appendEvent({
          run_id: run.id,
          type: `race.${side}`,
          payload: { side },
          idempotency_key: `${side}-${randomUUID()}`,
        }),
      ),
    );
    const events = await db.runtime.listEvents(run.id);
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: sides.length + 1 }, (_, index) => index + 1));
    expect(new Set(events.slice(1).map((event) => event.type))).toEqual(new Set(sides.map((side) => `race.${side}`)));
  });

  it('serializes event sequence when Run and Step mutations race across connections', async () => {
    const run = await createRun();
    const step = await db.runtime.createStep({
      run_id: run.id,
      step_key: 'event-race-step',
      kind: 'event-race',
      input: { permanent: true },
    });
    const claimedRun = await db.runtime.claimNextRun({
      run_id: run.id,
      worker_id: `event-race-${randomUUID()}`,
      lease_ms: 60_000,
      kinds: ['mission'],
    });
    const claimedStep = await db.runtime.claimNextStep({
      run_id: run.id,
      step_id: step.id,
      worker_id: claimedRun!.lease_owner!,
      lease_ms: 60_000,
    });
    const before = await db.runtime.listEvents(run.id);
    await Promise.all([
      db.runtime.transitionRun({
        id: run.id,
        expected_version: claimedRun!.version,
        to_status: 'running',
        idempotency_key: `event-race-run-${randomUUID()}`,
      }),
      db.runtime.transitionStep({
        id: step.id,
        expected_version: claimedStep!.version,
        to_status: 'running',
        idempotency_key: `event-race-step-${randomUUID()}`,
      }),
      db.runtime.appendEvent({
        run_id: run.id,
        type: 'race.external',
        payload: { side: 'external' },
        idempotency_key: `event-race-external-${randomUUID()}`,
      }),
    ]);
    const events = await db.runtime.listEvents(run.id);
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: events.length }, (_, index) => index + 1));
    expect(new Set(events.slice(before.length).map((event) => event.type))).toEqual(
      new Set(['run.status_changed', 'step.status_changed', 'race.external']),
    );
  });

  it('leases one outbox row to only one delivery worker', async () => {
    const run = await createRun();
    const topic = `runtime-race-topic-${randomUUID()}`;
    await db.runtime.appendEvent({
      run_id: run.id,
      type: 'race.delivery',
      payload: { permanent: true },
      idempotency_key: `delivery-${randomUUID()}`,
      topics: [topic],
    });
    const [left, right] = await Promise.all([
      db.runtime.claimOutbox({
        worker_id: `delivery-left-${randomUUID()}`,
        lease_ms: 60_000,
        topics: [topic],
        limit: 1,
      }),
      db.runtime.claimOutbox({
        worker_id: `delivery-right-${randomUUID()}`,
        lease_ms: 60_000,
        topics: [topic],
        limit: 1,
      }),
    ]);
    expect([...left, ...right]).toHaveLength(1);
    expect([...left, ...right][0]).toMatchObject({ status: 'claimed', attempts: 1 });
  });
});
