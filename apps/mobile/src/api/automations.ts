/**
 * Automations, 定时任务 (`/api/tasks`, apps/api/src/routes/tasks.ts): the list (a super's holds
 * every member's; src/automations/model.ts `myAutomations` keeps mine), one with its recent runs,
 * pause / resume (`PUT` `{ enabled }`), run now (answers the run's conversation), the run history
 * and delete (the runs' conversations stay). New ones are made in a conversation with the
 * assistant (its `automation_mutation` tool), never with a form here. Every call answers an
 * `ApiResult`, never throws.
 */

import type { Automation, AutomationRun } from '../automations/model';
import { del, get, post, put, seg, type ApiResult } from './client';

export const listAutomations = async (): Promise<ApiResult<Automation[]>> => {
  const result = await get<{ tasks: Automation[] }>('/api/tasks');
  return result.ok ? { ok: true, data: result.data.tasks ?? [] } : result;
};

export const getAutomation = (id: string) => get<{ task: Automation }>(`/api/tasks/${seg(id)}`);

export const listAutomationRuns = async (id: string): Promise<ApiResult<AutomationRun[]>> => {
  const result = await get<{ entries: AutomationRun[] }>(`/api/tasks/${seg(id)}/runs`);
  return result.ok ? { ok: true, data: result.data.entries ?? [] } : result;
};

export const setAutomationEnabled = (id: string, enabled: boolean) =>
  put<{ task: Automation }>(`/api/tasks/${seg(id)}`, { enabled });

export const runAutomationNow = (id: string) => post<{ ok: true; session_id: string }>(`/api/tasks/${seg(id)}/run`);

export const deleteAutomation = (id: string) => del<{ ok: true }>(`/api/tasks/${seg(id)}`);
