/**
 * Automations (scheduled tasks) — the slice a Bot's profile shows (its 定时
 * tab): list, pause / resume, run now, delete (`/api/tasks`, the web's
 * Automations page; canonical row type `ScheduledTask` in
 * packages/types/src/api.ts). Creating one stays with the Bot in its thread
 * (`automation_mutation` raises an approval card there). Nothing here throws:
 * reads answer `null` on failure, writes a boolean.
 *
 * `GET /api/tasks` lists a super's every member's automations too — callers
 * keep the member's own (`user_id`).
 */

import { api } from './client';

export interface Automation {
  id: number;
  user_id: string;
  name: string;
  /** `sprouty` (or a retired id that resolves to it) / `bot:<id>[@<v>]`. */
  profile_id: string;
  task_prompt: string;
  schedule: string;
  timezone: string;
  enabled: boolean;
  /** The server's next-run hint ("Next: <ISO>") — not shown; the 定时 tab words the cron itself. */
  schedule_desc?: string;
  last_run_at: string | null;
  last_status: string | null;
  next_run_at: string | null;
}

export async function listAutomations(): Promise<Automation[] | null> {
  try {
    const res = await api('/api/tasks');
    if (!res.ok) return null;
    const data = (await res.json()) as { tasks?: Automation[] };
    return data.tasks ?? [];
  } catch {
    return null;
  }
}

async function ok(path: string, init: RequestInit): Promise<boolean> {
  try {
    return (await api(path, init)).ok;
  } catch {
    return false;
  }
}

export function setAutomationEnabled(id: number, enabled: boolean): Promise<boolean> {
  return ok(`/api/tasks/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

export function runAutomation(id: number): Promise<boolean> {
  return ok(`/api/tasks/${id}/run`, { method: 'POST' });
}

export function deleteAutomation(id: number): Promise<boolean> {
  return ok(`/api/tasks/${id}`, { method: 'DELETE' });
}
