import {
  isRuntimeRunActive,
  projectRuntimeForUser,
  type RuntimeInterrupt,
  type RuntimeRun,
  type RuntimeRunKind,
  type RuntimeTransport,
  type RuntimeUserProjection,
} from '@greenhouse/types/runtime';
export { executionRunHref, parseExecutionSubPath } from '../../lib/execution-route';

export type TaskCenterTab = 'attention' | 'active' | 'completed' | 'failed' | 'all';
export type TaskCenterKindFilter = 'all' | Extract<RuntimeRunKind, 'mission' | 'workflow' | 'automation' | 'subagent'>;
export type TaskCenterScope = 'own' | 'all';
export type RuntimeConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface TaskCenterSummary {
  runs: {
    total: number;
    by_status: Record<string, number>;
    by_kind: Record<string, number>;
  };
  pending_interrupts: number;
}

export interface TaskCenterCounts {
  attention: number;
  active: number;
  completed: number;
  failed: number;
  all: number;
}

const ACTIVE_STATUSES = ['queued', 'claimed', 'running', 'waiting', 'paused'] as const;

function countStatuses(summary: TaskCenterSummary, statuses: readonly string[]): number {
  return statuses.reduce((total, status) => total + (summary.runs.by_status[status] ?? 0), 0);
}

export function taskCenterCounts(summary: TaskCenterSummary | null): TaskCenterCounts {
  if (!summary) return { attention: 0, active: 0, completed: 0, failed: 0, all: 0 };
  return {
    attention: summary.pending_interrupts,
    active: countStatuses(summary, ACTIVE_STATUSES),
    completed: summary.runs.by_status.succeeded ?? 0,
    failed: countStatuses(summary, ['failed', 'interrupted']),
    all: summary.runs.total,
  };
}

export function taskCenterKinds(
  filter: TaskCenterKindFilter,
): Array<'mission' | 'workflow' | 'automation' | 'subagent'> {
  return filter === 'all' ? ['mission', 'workflow', 'automation', 'subagent'] : [filter];
}

function objectPayload(value: RuntimeRun['input']): Record<string, unknown> | null {
  return value !== null && !Array.isArray(value) && typeof value === 'object' ? value : null;
}

function firstDisplayString(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function nestedObject(input: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = input[key];
  return value !== null && !Array.isArray(value) && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

export function runtimeRunTitle(run: RuntimeRun): string {
  const input = objectPayload(run.input);
  const automationTask = input && run.kind === 'automation' ? nestedObject(input, 'task') : null;
  const title =
    (input ? firstDisplayString(input, ['title', 'name', 'session_title', 'prompt', 'task', 'task_input']) : null) ??
    (automationTask ? firstDisplayString(automationTask, ['name']) : null);
  if (title) return title.split('\n')[0]!.trim();
  return run.source_id || run.id;
}

export function runtimeRunSubtitle(run: RuntimeRun): string | null {
  const input = objectPayload(run.input);
  if (!input) return null;
  const automationTask = run.kind === 'automation' ? nestedObject(input, 'task') : null;
  const prompt =
    firstDisplayString(input, ['prompt', 'task', 'task_input']) ??
    (automationTask ? firstDisplayString(automationTask, ['task_prompt']) : null) ??
    firstDisplayString(input, ['prepared_prompt']);
  const title =
    firstDisplayString(input, ['title', 'name', 'session_title']) ??
    (automationTask ? firstDisplayString(automationTask, ['name']) : null);
  if (!prompt || prompt === title) return null;
  return prompt.replace(/\s+/g, ' ').trim();
}

export function runtimeTransport(
  run: RuntimeRun,
  now = Date.now(),
  connection: RuntimeConnectionState = 'connected',
): RuntimeTransport {
  if (connection === 'connecting') return 'reconnecting';
  if (connection === 'disconnected') return 'offline';
  if (!isRuntimeRunActive(run.status)) return 'live';
  if (run.lease_expires_at && Date.parse(run.lease_expires_at) < now) return 'stale';
  return 'live';
}

export function runtimeRunProjection(
  run: RuntimeRun,
  interrupts: readonly RuntimeInterrupt[],
  now = Date.now(),
  connection: RuntimeConnectionState = 'connected',
): RuntimeUserProjection {
  return projectRuntimeForUser({
    status: run.status,
    interrupts: interrupts.filter((interrupt) => interrupt.run_id === run.id),
    transport: runtimeTransport(run, now, connection),
  });
}

export function filterTaskCenterRuns(
  runs: readonly RuntimeRun[],
  interrupts: readonly RuntimeInterrupt[],
  tab: TaskCenterTab,
): RuntimeRun[] {
  if (tab === 'all') return [...runs];
  if (tab === 'active') return runs.filter((run) => isRuntimeRunActive(run.status));
  if (tab === 'completed') return runs.filter((run) => run.status === 'succeeded');
  if (tab === 'failed') return runs.filter((run) => run.status === 'failed' || run.status === 'interrupted');
  const requiringAttention = new Set(
    interrupts.filter((interrupt) => interrupt.status === 'pending').map((interrupt) => interrupt.run_id),
  );
  return runs.filter((run) => requiringAttention.has(run.id));
}

export function payloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  return JSON.stringify(payload, null, 2);
}
