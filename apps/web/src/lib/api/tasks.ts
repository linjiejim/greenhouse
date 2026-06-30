/**
 * Scheduled Tasks API — CRUD, manual trigger, execution history.
 */

import type { ScheduledTask, ScheduledTaskInput, TaskRunSummary } from '@greenhouse/types/api';
import { rpc } from './client';

export async function listTasks(): Promise<(ScheduledTask & { schedule_desc?: string })[]> {
  try {
    const res = await rpc.api.tasks.$get();
    if (!res.ok) return [];
    return (await res.json()).tasks ?? [];
  } catch {
    return [];
  }
}

export async function createTask(input: ScheduledTaskInput): Promise<ScheduledTask> {
  const res = await rpc.api.tasks.$post({ json: input });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Create failed' }));
    throw new Error(err.error || `Create failed: ${res.status}`);
  }
  const data = await res.json();
  return data.task;
}

export async function getTask(
  id: number,
): Promise<{ task: ScheduledTask & { schedule_desc?: string }; recent_runs: TaskRunSummary[] }> {
  const res = await rpc.api.tasks[':id'].$get({ param: { id: String(id) } });
  if (!res.ok) throw new Error(`getTask failed: ${res.status}`);
  return res.json();
}

export async function updateTask(
  id: number,
  updates: Partial<ScheduledTaskInput> & { enabled?: boolean },
): Promise<ScheduledTask> {
  // Non-literal arg: hc only types `json` for validator-backed routes (none yet);
  // the indirection passes the body while keeping param/response typing.
  const args = { param: { id: String(id) }, json: updates };
  const res = await rpc.api.tasks[':id'].$put(args);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Update failed' }));
    throw new Error(('error' in err && err.error) || `Update failed: ${res.status}`);
  }
  const data = await res.json();
  return data.task;
}

export async function deleteTask(id: number): Promise<void> {
  const res = await rpc.api.tasks[':id'].$delete({ param: { id: String(id) } });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Delete failed' }));
    throw new Error(('error' in err && err.error) || `Delete failed: ${res.status}`);
  }
}

export async function runTask(id: number): Promise<{ session_id: string }> {
  const res = await rpc.api.tasks[':id'].run.$post({ param: { id: String(id) } });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Run failed' }));
    throw new Error(('error' in err && err.error) || `Run failed: ${res.status}`);
  }
  return res.json();
}

export async function getTaskHistory(id: number): Promise<TaskRunSummary[]> {
  try {
    const res = await rpc.api.tasks[':id'].history.$get({ param: { id: String(id) } });
    if (!res.ok) return [];
    return (await res.json()).runs ?? [];
  } catch {
    return [];
  }
}
