import type { CreateScheduleInput, UpdateScheduleInput, Schedule, Page, StandingApproval } from '../shared/contract';
import { del, get, patch, post, seg } from './client';

export const schedules = (agent: string) => get<{ items: Schedule[] }>('/api/schedules', { agent });
export const createSchedule = (input: CreateScheduleInput) => post<Schedule>('/api/schedules', input);
export const updateSchedule = (id: string, input: UpdateScheduleInput) =>
  patch<Schedule>(`/api/schedules/${seg(id)}`, input);
export const scheduleAction = (id: string, action: 'pause' | 'resume' | 'run-now') =>
  post<Schedule>(`/api/schedules/${seg(id)}/${action}`);
export const removeSchedule = (id: string) => del(`/api/schedules/${seg(id)}`);
export const standingApprovals = (agent: string, cursor?: string) =>
  get<Page<StandingApproval>>(`/api/agents/${seg(agent)}/standing-approvals`, { cursor });
export const revokeApproval = (agent: string, id: string) =>
  del(`/api/agents/${seg(agent)}/standing-approvals/${seg(id)}`);
