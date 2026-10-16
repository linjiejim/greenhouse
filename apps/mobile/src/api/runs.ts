/**
 * Runs on API v2 (`/api/runs`): background work — the list (active, done), one run with its
 * steps and events, cancel, and retry (only the failed steps run again). Schedules belong to
 * Agents (`/api/schedules?agent=`). Every call answers an `ApiResult` (./client.ts).
 */

import type { Page, RunDetail, RunView, Schedule } from '../shared/contract';
import { get, post, seg } from './client';

export const listRuns = (
  query: { state?: 'active' | 'done' | 'all'; agent?: string; source?: RunView['source']; cursor?: string; limit?: number } = {},
) => get<Page<RunView>>('/api/runs', query);

export const getRun = (id: string) => get<RunDetail>(`/api/runs/${seg(id)}`);

export const cancelRun = (id: string) => post<RunDetail>(`/api/runs/${seg(id)}/cancel`);

export const retryRun = (id: string) => post<RunDetail>(`/api/runs/${seg(id)}/retry`);

/** Every schedule of my Agents, or one Agent's. */
export const listSchedules = (agent?: string) => get<{ items: Schedule[] }>('/api/schedules', { agent });
