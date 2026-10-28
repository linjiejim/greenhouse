import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeRunRow } from '@greenhouse/db';

const mocks = vi.hoisted(() => ({
  automation: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../scheduler/runtime-driver.js', () => ({ reconcileReclaimedAutomationRun: mocks.automation }));
vi.mock('../scheduler/notify.js', () => ({ notifyTaskResult: mocks.notify }));

import { createRuntimeDomainProjector } from './domain-projector.js';
import type { RuntimeEventEnvelope } from './worker.js';

function run(overrides: Partial<RuntimeRunRow> = {}): RuntimeRunRow {
  return {
    id: 'runtime-1',
    kind: 'automation',
    owner_user_id: 'owner',
    initiated_by_user_id: 'owner',
    session_id: null,
    parent_run_id: null,
    root_run_id: 'runtime-1',
    source_kind: 'scheduled_task:42',
    source_id: 'session-1',
    idempotency_key: 'session-1',
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
    input: {},
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
    payload: { result } as unknown as RuntimeEventEnvelope['payload'],
    actor_user_id: null,
    created_at: '2026-08-12T00:00:00.000Z',
  } satisfies RuntimeEventEnvelope;
}

describe('Runtime durable domain projector', () => {
  beforeEach(() => vi.clearAllMocks());

  it('projects a matching terminal recovery and lets failure reject for Outbox retry', async () => {
    const current = run();
    const db = { runtime: { getRun: vi.fn().mockResolvedValue(current) } };
    mocks.automation.mockRejectedValueOnce(new Error('temporary source outage'));

    await expect(createRuntimeDomainProjector(db as never)(event(current, 'run.lease_expired'))).rejects.toThrow(
      'temporary source outage',
    );
    expect(mocks.automation).toHaveBeenCalledWith(db, current);
  });

  it('ignores an old recovery event after a newer successful retry', async () => {
    const stale = run();
    const current = run({ status: 'succeeded', version: 10, error_code: null, error_message: null });
    const db = { runtime: { getRun: vi.fn().mockResolvedValue(current) } };

    await createRuntimeDomainProjector(db as never)(event(stale));

    expect(mocks.automation).not.toHaveBeenCalled();
  });

  it('projects an Automation outcome and enqueues one deep-linked durable notification', async () => {
    const task = {
      id: '42',
      user_id: 'owner',
      name: 'Daily report',
      profile_id: 'sprouty',
      task_prompt: 'Summarize today',
      schedule: '0 18 * * *',
      timezone: 'Asia/Hong_Kong',
      enabled: true,
      max_steps: 15,
      notify: { webhook: null, email: true, wecom: false, feishu: false },
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
      input: { task, session_id: 'session-42', scheduled_for: '2026-08-12T10:00:00.000Z' },
      output: { summary: 'Everything is healthy.' },
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
      expect.objectContaining({ runtime_run_id: current.id, status: 'succeeded', task_id: '42' }),
    );
    expect(mocks.notify).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        id: '42',
        name: 'Daily report',
        notify: { webhook: null, email: true, wecom: false, feishu: false },
      }),
      { status: 'completed', summary: 'Everything is healthy.', sessionId: 'session-42' },
      { runId: current.id, eventId: 'event-1' },
    );
  });
});

it('publishes metadata-only run and conversation observations from a matching terminal outbox event', async () => {
  const { registerExtensionHooks } = await import('../plugin-host/events.js');
  const observed: unknown[] = [];
  registerExtensionHooks('metadata-observer', (hooks) => {
    hooks.on('run.completed', (payload) => {
      observed.push(payload);
    });
    hooks.on('conversation.turn.completed', (payload) => {
      observed.push(payload);
    });
  });
  const current = run({
    kind: 'chat',
    status: 'succeeded',
    session_id: 'conversation-1',
    output: { text: 'PRIVATE CONTENT' },
  });
  const db = { runtime: { getRun: vi.fn().mockResolvedValue(current) } };
  await createRuntimeDomainProjector(db as never)(event(current));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(observed).toEqual([
    { runId: current.id, userId: 'owner', kind: 'chat', status: 'succeeded' },
    { conversationId: 'conversation-1', userId: 'owner' },
  ]);
});
