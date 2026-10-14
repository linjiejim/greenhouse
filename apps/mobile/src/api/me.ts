/**
 * The member's own settings on API v2 (`/api/me/*`) that the app shows: notification delivery
 * (channels by category, previews) and this phone's push registration, plus the read-only
 * directory of people (`/api/members`) and the skills `/` offers.
 * Every call answers an `ApiResult` (./client.ts), never throws.
 *
 * Push devices keep v1's request and response shapes (only the path moved to `/api/me`): `PUT`
 * registers or refreshes a phone by its token (`enabled: false` = this deployment sends no
 * pushes, nothing was stored), `PATCH` narrows this phone's switches, `DELETE` disables it, `test`
 * sends one now (`push_disabled`, `device_disabled`, `too_soon`, `device_not_registered`,
 * `send_failed`). The Expo token only ever travels inward.
 */

import type {
  MemberSummary,
  NotificationSettings,
  Page,
  PushDevice,
  PushDeviceList,
  PushDeviceRegistered,
  PushPrefs,
  RegisterPushDeviceInput,
  Skill,
  SkillStarters,
  UpdateNotificationSettingsInput,
} from '../shared/contract';
import { del, get, patch, post, put, seg } from './client';

export const notificationSettings = () => get<NotificationSettings>('/api/me/notification-settings');

/** Fields left out keep their value. */
export const saveNotificationSettings = (input: UpdateNotificationSettingsInput) =>
  put<NotificationSettings>('/api/me/notification-settings', input);

const DEVICES = '/api/me/push-devices';

export const listPushDevices = () => get<PushDeviceList>(DEVICES);

export const registerPushDevice = (input: RegisterPushDeviceInput) => put<PushDeviceRegistered>(DEVICES, input);

export const updatePushPrefs = (id: string, prefs: Partial<PushPrefs>) =>
  patch<{ device: PushDevice }>(`${DEVICES}/${seg(id)}`, { prefs });

/** Disabled, never deleted: registering the phone again brings it back. */
export const unregisterPushDevice = (id: string) => del<{ ok: true }>(`${DEVICES}/${seg(id)}`);

export const sendTestPush = (id: string) => post<{ ok: true }>(`${DEVICES}/${seg(id)}/test`);

/** People in the workspace, narrowed by name or email. */
export const memberDirectory = (q?: string) => get<{ items: MemberSummary[] }>('/api/members', { q: q || undefined });

/** Skills I can see; `available` (and why not) is judged for `agent` (the main Agent by default). */
export const listSkills = (query: { agent?: string; q?: string; limit?: number } = {}) =>
  get<Page<Skill>>('/api/skills', query);

/** A new chat's empty state: my three most-used skills for this Agent, else its template's starters. */
export const skillStarters = (agent?: string) => get<SkillStarters>('/api/skills/starters', { agent });
