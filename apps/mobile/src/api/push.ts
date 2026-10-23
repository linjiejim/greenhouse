/**
 * This phone's push registration with the active station (`/api/auth/me/push-devices`,
 * apps/api/src/routes/push-devices.ts). `PUT` registers or refreshes a phone by its Expo token
 * (`enabled: false` = this deployment sends no pushes, nothing was stored), `PATCH` narrows this
 * phone's switches, `DELETE` disables it, `test` sends one now. The Expo token only ever travels
 * inward. Every call answers an `ApiResult` (./client.ts), never throws.
 */

import type {
  PushDeviceListResponse,
  PushDeviceRegisterRequest,
  PushDeviceRegisterResponse,
  PushDeviceView,
  PushPrefs,
} from '../shared/push';
import { del, get, patch, post, put, seg } from './client';

export const PUSH_DEVICES_PATH = '/api/auth/me/push-devices';

export const listPushDevices = () => get<PushDeviceListResponse>(PUSH_DEVICES_PATH);

export const registerPushDevice = (input: PushDeviceRegisterRequest) =>
  put<PushDeviceRegisterResponse>(PUSH_DEVICES_PATH, input);

export const updatePushPrefs = (id: string, prefs: Partial<PushPrefs>) =>
  patch<{ device: PushDeviceView }>(`${PUSH_DEVICES_PATH}/${seg(id)}`, { prefs });

/** Disabled, never deleted: registering the phone again brings it back. */
export const unregisterPushDevice = (id: string) => del<{ ok: true }>(`${PUSH_DEVICES_PATH}/${seg(id)}`);

export const sendTestPush = (id: string) => post<{ ok: true }>(`${PUSH_DEVICES_PATH}/${seg(id)}/test`);
