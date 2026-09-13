import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider, RuntimeOutboxRow, RuntimeRunRow } from '@greenhouse/db';

const ws = vi.hoisted(() => ({ sendToUser: vi.fn(), broadcastToSuperExcept: vi.fn() }));

vi.mock('../ws/connection-manager.js', () => ({ connectionManager: ws }));

import { startRuntimeWorker } from './worker.js';

function runtimeRun(overrides: Partial<RuntimeRunRow> = {}): RuntimeRunRow {
  return {
    id: 'rtm_car_1',
    kind: 'mission',
    owner_user_id: 'user-1',
    initiated_by_user_id: 'user-1',
    session_id: null,
    parent_run_id: null,
    root_run_id: 'rtm_car_1',
    source_kind: 'agent_run',
    source_id: 'car_1',
    idempotency_key: 'mission:car_1',
    status: 'running',
    desired_state: 'run',
    wait_reason: null,
    priority: 0,
    not_before: null,
    deadline_at: null,
    lease_owner: null,
    lease_expires_at: null,
    heartbeat_at: null,
    attempt: 0,
    max_attempts: 1,
    input: '{}',
    output: null,
    error_code: null,
    error_message: null,
    started_at: null,
    ended_at: null,
    settled_at: null,
    created_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

function outbox(overrides: Partial<RuntimeOutboxRow> = {}): RuntimeOutboxRow {
  return {
    id: 'rto_1',
    event_id: 'rte_1',
    topic: 'runtime.events',
    payload: JSON.stringify({
      event_id: 'rte_1',
      run_id: 'rtm_car_1',
      step_id: null,
      seq: 3,
      type: 'run.status_changed',
      payload: { exact: 'full' },
      actor_user_id: 'user-1',
      created_at: '2026-08-12T00:00:00.000Z',
    }),
    status: 'claimed',
    attempts: 1,
    max_attempts: 10,
    available_at: '2026-08-12T00:00:00.000Z',
    lease_owner: 'worker',
    lease_expires_at: '2026-08-12T00:01:00.000Z',
    last_error: null,
    delivered_at: null,
    created_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
    version: 2,
    ...overrides,
  };
}

function fakeDb(item: RuntimeOutboxRow | null) {
  const runtime = {
    reclaimStaleRuns: vi.fn().mockResolvedValue([]),
    expireInterrupts: vi.fn().mockResolvedValue([]),
    claimNextRun: vi.fn().mockResolvedValue(undefined),
    claimOutbox: vi.fn().mockResolvedValue(item ? [item] : []),
    getRun: vi.fn().mockResolvedValue(runtimeRun()),
    acknowledgeOutbox: vi.fn().mockResolvedValue(undefined),
    failOutbox: vi.fn().mockResolvedValue({ ...item, status: 'failed', version: 3 }),
    retryOutbox: vi.fn().mockResolvedValue(undefined),
  };
  return { db: { runtime } as unknown as DatabaseProvider, runtime };
}

describe('Runtime durable worker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('acks only after full-payload projection and sends a content-free invalidation', async () => {
    const { db, runtime } = fakeDb(outbox());
    const onEvent = vi.fn().mockResolvedValue(undefined);
    const worker = await startRuntimeWorker({
      db,
      workerId: 'worker',
      onEvent,
      skipBootPass: true,
      intervalMs: 60_000,
    });
    await worker.runOnce();
    worker.stop();

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ payload: { exact: 'full' } }));
    expect(runtime.acknowledgeOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rto_1', expected_version: 2, worker_id: 'worker' }),
    );
    expect(runtime.failOutbox).not.toHaveBeenCalled();
    expect(ws.sendToUser).toHaveBeenCalledWith('user-1', {
      type: 'runtime:invalidate',
      runId: 'rtm_car_1',
      kind: 'mission',
      eventType: 'run.status_changed',
      seq: 3,
    });
    expect(ws.broadcastToSuperExcept).toHaveBeenCalledWith('user-1', {
      type: 'runtime:invalidate',
      runId: 'rtm_car_1',
      kind: 'mission',
      eventType: 'run.status_changed',
      seq: 3,
    });
  });

  it('fails then schedules retry when a projector rejects the event', async () => {
    const item = outbox();
    const { db, runtime } = fakeDb(item);
    const worker = await startRuntimeWorker({
      db,
      workerId: 'worker',
      onEvent: vi.fn().mockRejectedValue(new Error('notification unavailable')),
      skipBootPass: true,
      intervalMs: 60_000,
    });
    await worker.runOnce();
    worker.stop();

    expect(runtime.acknowledgeOutbox).not.toHaveBeenCalled();
    expect(runtime.failOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ id: item.id, expected_version: item.version, worker_id: 'worker' }),
    );
    expect(runtime.retryOutbox).toHaveBeenCalledWith(expect.objectContaining({ id: item.id, expected_version: 3 }));
  });

  it('never claims executable work when no driver is registered', async () => {
    const { db, runtime } = fakeDb(null);
    const worker = await startRuntimeWorker({ db, skipBootPass: true, intervalMs: 60_000 });
    await worker.runOnce();
    worker.stop();
    expect(runtime.claimNextRun).not.toHaveBeenCalled();
    expect(runtime.reclaimStaleRuns).toHaveBeenCalledOnce();
    expect(runtime.expireInterrupts).toHaveBeenCalledOnce();
  });

  it('projects every reclaimed run without letting one failure block the next', async () => {
    const { db, runtime } = fakeDb(null);
    const first = runtimeRun({ id: 'stale-1', root_run_id: 'stale-1', status: 'failed' });
    const second = runtimeRun({ id: 'stale-2', root_run_id: 'stale-2', status: 'queued' });
    runtime.reclaimStaleRuns.mockResolvedValueOnce([first, second]);
    const onRunReclaimed = vi
      .fn()
      .mockRejectedValueOnce(new Error('source unavailable'))
      .mockResolvedValueOnce(undefined);
    const worker = await startRuntimeWorker({
      db,
      onRunReclaimed,
      skipBootPass: true,
      intervalMs: 60_000,
    });

    await worker.runOnce();
    worker.stop();

    expect(onRunReclaimed).toHaveBeenNthCalledWith(1, first);
    expect(onRunReclaimed).toHaveBeenNthCalledWith(2, second);
    expect(runtime.claimOutbox).toHaveBeenCalledOnce();
  });

  it('keeps maintenance passes responsive while a durable driver owns a long lease', async () => {
    const { db, runtime } = fakeDb(null);
    runtime.claimNextRun.mockResolvedValueOnce(
      runtimeRun({
        id: 'eval-runtime-1',
        root_run_id: 'eval-runtime-1',
        kind: 'eval',
        source_kind: 'eval_run',
        source_id: 'eval-domain-1',
        status: 'claimed',
        lease_owner: 'worker',
      }),
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const driver = vi.fn(async () => held);
    const worker = await startRuntimeWorker({
      db,
      workerId: 'worker',
      drivers: { eval: driver },
      skipBootPass: true,
      intervalMs: 60_000,
    });

    const pass = worker.runOnce();
    const outcome = await Promise.race([
      pass.then(() => 'responsive' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ]);
    release();
    await held;
    worker.stop();

    expect(outcome).toBe('responsive');
    expect(driver).toHaveBeenCalledOnce();
  });

  it('claims up to the configured per-kind concurrency without exceeding it', async () => {
    const { db, runtime } = fakeDb(null);
    runtime.claimNextRun
      .mockResolvedValueOnce(
        runtimeRun({ id: 'automation-1', root_run_id: 'automation-1', kind: 'automation', status: 'claimed' }),
      )
      .mockResolvedValueOnce(
        runtimeRun({ id: 'automation-2', root_run_id: 'automation-2', kind: 'automation', status: 'claimed' }),
      )
      .mockResolvedValueOnce(
        runtimeRun({ id: 'automation-3', root_run_id: 'automation-3', kind: 'automation', status: 'claimed' }),
      );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const driver = vi.fn(async () => held);
    const worker = await startRuntimeWorker({
      db,
      workerId: 'worker',
      drivers: { automation: driver },
      driverConcurrency: { automation: 2 },
      skipBootPass: true,
      intervalMs: 60_000,
    });

    await worker.runOnce();

    expect(runtime.claimNextRun).toHaveBeenCalledTimes(2);
    expect(driver).toHaveBeenCalledTimes(2);
    release();
    await held;
    worker.stop();
  });
});
