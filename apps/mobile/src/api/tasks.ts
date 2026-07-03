/**
 * Scheduled Tasks API (read-only subset for the widget snapshot).
 * Shape mirrors apps/api/src/routes/tasks.ts GET /api/tasks (rows from
 * packages/db scheduled-task.ts + schedule_desc). Permission is internal+;
 * external users get an empty list via the apiJson fallback.
 */

import { api, apiJson } from './client';

export interface ScheduledTask {
  id: string;
  name: string;
  schedule: string;
  timezone: string | null;
  enabled: boolean;
  last_run_at: string | null;
  last_status: 'completed' | 'failed' | 'running' | null;
  next_run_at: string | null;
  schedule_desc?: string;
}

export async function listTasks(): Promise<ScheduledTask[]> {
  const data = await apiJson<{ tasks: ScheduledTask[] }>('/api/tasks', { tasks: [] });
  return data.tasks ?? [];
}

export async function triggerTask(id: string): Promise<boolean> {
  try {
    const res = await api(`/api/tasks/${id}/run`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}
