import type { RuntimeRun } from '@greenhouse/types/runtime';
import { describe, expect, it } from 'vitest';
import { executionRunHref, parseExecutionSubPath, runtimeRunTitle, runtimeTransport } from './model.js';

function run(overrides: Partial<RuntimeRun> = {}): RuntimeRun {
  return {
    id: 'run-1',
    kind: 'mission',
    owner_user_id: 'user-1',
    initiated_by_user_id: 'user-1',
    session_id: null,
    parent_run_id: null,
    root_run_id: 'run-1',
    source_kind: 'agent_run',
    source_id: 'source-1',
    idempotency_key: null,
    status: 'running',
    desired_state: 'run',
    wait_reason: null,
    priority: 0,
    not_before: null,
    deadline_at: null,
    lease_owner: 'worker-1',
    lease_expires_at: '2999-01-01T00:00:00.000Z',
    heartbeat_at: '2026-08-12T00:00:00.000Z',
    attempt: 1,
    max_attempts: 3,
    input: { prompt: 'Research the market\nwith sources' },
    output: null,
    error_code: null,
    error_message: null,
    started_at: '2026-08-12T00:00:00.000Z',
    ended_at: null,
    settled_at: null,
    created_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

describe('Runtime run detail view model', () => {
  it('creates and parses canonical deep links without confusing the legacy prompt Tasks', () => {
    expect(executionRunHref(run())).toBe('#/activity/mission/run-1');
    expect(parseExecutionSubPath('workflow/run%2F42')).toEqual({ kind: 'workflow', runId: 'run/42' });
    expect(parseExecutionSubPath('')).toEqual({ kind: null, runId: null });
  });

  it('derives a readable title without changing the complete stored prompt', () => {
    const value = run();
    expect(runtimeRunTitle(value)).toBe('Research the market');
    expect(value.input).toEqual({ prompt: 'Research the market\nwith sources' });
  });

  it('uses the immutable Automation task snapshot for its title', () => {
    const value = run({
      kind: 'automation',
      source_kind: 'scheduled_task:42',
      source_id: 'scheduled:2026-08-12T03:00:00.000Z',
      input: {
        schema: 1,
        task: { name: 'Daily CRM brief', task_prompt: 'Summarize durable CRM changes' },
        prepared_prompt: 'Summarize durable CRM changes\n\nCurrent time: 2026-08-12',
        session_title: 'Scheduled: Daily CRM brief — Aug 12',
      },
    });

    expect(runtimeRunTitle(value)).toBe('Scheduled: Daily CRM brief — Aug 12');
  });

  it('derives the connection state of a run independently of its status', () => {
    expect(runtimeTransport(run())).toBe('live');
    expect(runtimeTransport(run({ lease_expires_at: '2020-01-01T00:00:00.000Z' }))).toBe('stale');
    expect(runtimeTransport(run(), Date.now(), 'connecting')).toBe('reconnecting');
    expect(runtimeTransport(run(), Date.now(), 'disconnected')).toBe('offline');
  });
});
