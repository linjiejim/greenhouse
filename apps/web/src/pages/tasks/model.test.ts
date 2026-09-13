import type { RuntimeInterrupt, RuntimeRun } from '@greenhouse/types/runtime';
import { describe, expect, it } from 'vitest';
import {
  executionRunHref,
  filterTaskCenterRuns,
  parseExecutionSubPath,
  runtimeRunProjection,
  runtimeRunSubtitle,
  runtimeRunTitle,
  taskCenterCounts,
  taskCenterKinds,
} from './model.js';

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

function interrupt(overrides: Partial<RuntimeInterrupt> = {}): RuntimeInterrupt {
  return {
    id: 'interrupt-1',
    run_id: 'run-1',
    step_id: null,
    tool_call_id: null,
    kind: 'mutation_approval',
    status: 'pending',
    payload: { action: 'update' },
    canonical_input_hash: 'hash',
    risk_level: 'r1',
    assignee_user_id: 'user-1',
    expires_at: null,
    decision: null,
    decided_by_user_id: null,
    decided_at: null,
    created_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

describe('Execution Center view model', () => {
  it('creates and parses canonical deep links without confusing the legacy prompt Tasks', () => {
    expect(executionRunHref(run())).toBe('#/executions/mission/run-1');
    expect(parseExecutionSubPath('workflow/run%2F42')).toEqual({ kind: 'workflow', runId: 'run/42' });
    expect(parseExecutionSubPath('')).toEqual({ kind: null, runId: null });
  });

  it('keeps all durable user task kinds in the shared filter', () => {
    expect(taskCenterKinds('all')).toEqual(['mission', 'workflow', 'automation', 'subagent']);
    expect(taskCenterKinds('automation')).toEqual(['automation']);
  });

  it('derives a readable title without changing the complete stored prompt', () => {
    const value = run();
    expect(runtimeRunTitle(value)).toBe('Research the market');
    expect(value.input).toEqual({ prompt: 'Research the market\nwith sources' });
  });

  it('uses the immutable Automation task snapshot for its title and subtitle', () => {
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
    expect(runtimeRunSubtitle(value)).toBe('Summarize durable CRM changes');
  });

  it('projects execution, interaction and transport independently', () => {
    expect(runtimeRunProjection(run(), [interrupt()])).toEqual({
      lifecycle: 'running',
      attention: 'approval',
      transport: 'live',
    });
    expect(runtimeRunProjection(run({ lease_expires_at: '2020-01-01T00:00:00.000Z' }), [], Date.now()).transport).toBe(
      'stale',
    );
    expect(runtimeRunProjection(run(), [], Date.now(), 'connecting').transport).toBe('reconnecting');
    expect(runtimeRunProjection(run(), [], Date.now(), 'disconnected').transport).toBe('offline');
  });

  it('filters attention and execution tabs from separate facts', () => {
    const completed = run({ id: 'run-2', status: 'succeeded' });
    expect(filterTaskCenterRuns([run(), completed], [interrupt()], 'attention').map((item) => item.id)).toEqual([
      'run-1',
    ]);
    expect(filterTaskCenterRuns([run(), completed], [], 'completed').map((item) => item.id)).toEqual(['run-2']);
  });

  it('uses the server summary for whole-collection tab counts', () => {
    expect(
      taskCenterCounts({
        runs: {
          total: 9,
          by_status: { queued: 1, running: 2, waiting: 1, succeeded: 3, failed: 1, interrupted: 1 },
          by_kind: { mission: 6, workflow: 3 },
        },
        pending_interrupts: 2,
      }),
    ).toEqual({ attention: 2, active: 4, completed: 3, failed: 2, all: 9 });
  });
});
