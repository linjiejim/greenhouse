/**
 * Push devices — this phone's registration with a station
 * (`/api/auth/me/push-devices`, apps/api/src/routes/push-devices.ts; spec
 * docs/specs/20261010-mobile-push.md §3.3). Shapes: src/shared/push.ts (vendored).
 *
 * `'unsupported'` = the station answered 404 — an older server with no pushes:
 * the app shows no push entry for it. Reads answer null when the request failed.
 * The Expo token only ever travels inward.
 */

import type {
  PushDeviceListResponse,
  PushDeviceRegisterRequest,
  PushDeviceRegisterResponse,
  PushDeviceView,
  PushPrefs,
  PushTestErrorCode,
} from '../shared/push';
import { api } from './client';

const BASE = '/api/auth/me/push-devices';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** This account's registered phones on the active station, and whether the station pushes at all. */
export async function listPushDevices(): Promise<PushDeviceListResponse | 'unsupported' | null> {
  try {
    const res = await api(BASE);
    if (res.status === 404) return 'unsupported';
    if (!res.ok) return null;
    return (await res.json()) as PushDeviceListResponse;
  } catch {
    return null;
  }
}

/** Register / refresh this phone (`enabled: false` = the station has pushes off; nothing was stored). */
export async function registerPushDevice(
  body: PushDeviceRegisterRequest,
): Promise<PushDeviceRegisterResponse | 'unsupported' | null> {
  try {
    const res = await api(BASE, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) });
    if (res.status === 404) return 'unsupported';
    if (!res.ok) return null;
    return (await res.json()) as PushDeviceRegisterResponse;
  } catch {
    return null;
  }
}

export async function updatePushPrefs(id: string, prefs: Partial<PushPrefs>): Promise<PushDeviceView | null> {
  try {
    const res = await api(`${BASE}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ prefs }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { device?: PushDeviceView };
    return data.device ?? null;
  } catch {
    return null;
  }
}

/** Unregister this phone on the active station (sign-out, pushes switched off). */
export async function unregisterPushDevice(id: string): Promise<boolean> {
  try {
    const res = await api(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

export type PushTestResult = { ok: true } | { ok: false; code: PushTestErrorCode | null; error: string };

/** Ask the station to send this phone a test push now (≤ once per 10 s). */
export async function sendTestPush(id: string): Promise<PushTestResult> {
  try {
    const res = await api(`${BASE}/${encodeURIComponent(id)}/test`, { method: 'POST' });
    const body = (await res.json().catch(() => ({}))) as { ok?: unknown; code?: unknown; error?: unknown };
    if (res.ok && body.ok === true) return { ok: true };
    return {
      ok: false,
      code: typeof body.code === 'string' ? (body.code as PushTestErrorCode) : null,
      error: typeof body.error === 'string' ? body.error : `HTTP ${res.status}`,
    };
  } catch (err) {
    return { ok: false, code: null, error: err instanceof Error ? err.message : String(err) };
  }
}
