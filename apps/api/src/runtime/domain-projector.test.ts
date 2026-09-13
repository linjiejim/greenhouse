import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeRunRow } from '@greenhouse/db';

const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
  automation: vi.fn(),
  subagent: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('./eval-driver.js', () => ({ reconcileReclaimedEvalRun: mocks.eval }));
vi.mock('../scheduler/runtime-driver.js', () => ({ reconcileReclaimedAutomationRun: mocks.automation }));
vi.mock('../scheduler/notify.js', () => ({ notifyTaskResult: mocks.notify }));
vi.mock('./subagent-driver.js', () => ({ reconcileReclaimedSubagentRun: mocks.subagent }));

import { createRuntimeDomainProjector } from './domain-projector.js';

function run(overrides: Partial<RuntimeRunRow> = {}): RuntimeRunRow {
  return {
    id: 'runtime-1',
    kind: 'eval',
    owner_user_id: 'owner',
    initiated_by_user_id: 'owner',
    session_id: null,
    parent_run_id: null,
    root_run_id: 'runtime-1',
    source_kind: 'eval_run',
    source_id: 'eval-1',
    idempotency_key: 'eval-1',
    status: 'failed',
    desired_state: 'run',
    wait_reason: null,
    priority: 0,
    not_before: null,
    deadline_at: null,
    lease_owner: null,
    lease_expires_at: null,
    heartbeat_at: null,
    attempt: 3,
    max_attempts: 3,
    input: '{}',
    output: null,
    error_code: 'runtime_attempts_exhausted',
    error_message: 'lease expired',
    started_at: null,
    ended_at: '2026-08-12T00:00:00.000Z',
    settled_at: null,
    created_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
    version: 7,
    ...overrides,
  };
}

function event(result: RuntimeRunRow, type: 'run.status_changed' | 'run.lease_expired' = 'run.status_changed') {
  return {
    event_id: 'event-1',
    run_id: result.id,
    step_id: null,
    seq: 5,
    type,
    payload: { result },
    actor_user_id: null,
    created_at: '2026-08-12T00:00:00.000Z',
  } as const;
}

describe('Runtime durable domain projector', () => {
  beforeEach(() => vi.clearAllMocks());

  it('projects a matching terminal recovery and lets failure reject for Outbox retry', async () => {
    const current = run();
    const db = { runtime: { getRun: vi.fn().mockResolvedValue(current) } };
    mocks.eval.mockRejectedValueOnce(new Error('temporary source outage'));

    await expect(createRuntimeDomainProjector(db as never)(event(current, 'run.lease_expired'))).rejects.toThrow(
      'temporary source outage',
    );
    expect(mocks.eval).toHaveBeenCalledWith(db, current);
  });

  it('ignores an old recovery event after a newer successful retry', async () => {
    const stale = run();
    const current = run({ status: 'succeeded', version: 10, error_code: null, error_message: null });
    const db = { runtime: { getRun: vi.fn().mockResolvedValue(current) } };

    await createRuntimeDomainProjector(db as never)(event(stale));

    expect(mocks.eval).not.toHaveBeenCalled();
  });

  it('projects an Automation outcome and enqueues one deep-linked durable notification', async () => {
    const task = {
      id: 42,
      user_id: 'owner',
      name: 'Daily report',
      profile_id: 'team',
      task_prompt: 'Summarize today',
      schedule: '0 18 * * *',
      timezone: 'Asia/Hong_Kong',
      enabled: true,
      max_steps: 15,
      notify_webhook: null,
      notify_email: true,
      notify_wecom: false,
      last_run_at: null,
      last_status: null,
      next_run_at: null,
      run_count: 0,
      created_at: '2026-08-12T00:00:00.000Z',
      updated_at: '2026-08-12T00:00:00.000Z',
    };
    const current = run({
      kind: 'automation',
      status: 'succeeded',
      source_kind: 'scheduled_task:42',
      source_id: 'scheduled:2026-08-12T10:00:00.000Z',
      input: JSON.stringify({ task, session_id: 'session-42', scheduled_for: '2026-08-12T10:00:00.000Z' }),
      output: JSON.stringify({ summary: 'Everything is healthy.' }),
      error_code: null,
      error_message: null,
    });
    const projectRuntimeOutcome = vi.fn().mockResolvedValue({ created: true, task_updated: true });
    const db = {
      runtime: { getRun: vi.fn().mockResolvedValue(current) },
      scheduledTasks: { projectRuntimeOutcome },
    };

    await createRuntimeDomainProjector(db as never)(event(current));

    expect(projectRuntimeOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ runtime_run_id: current.id, status: 'succeeded', task_id: 42 }),
    );
    expect(mocks.notify).toHaveBeenCalledWith(
      db,
      task,
      { status: 'completed', summary: 'Everything is healthy.', sessionId: 'session-42' },
      { runId: current.id, eventId: 'event-1' },
    );
  });
});
