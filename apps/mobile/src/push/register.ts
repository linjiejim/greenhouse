/**
 * This phone's push registration (spec docs/specs/20261010-mobile-push.md §2.3, §2.4,
 * §3.5) — iOS only (Bots, and so pushes, are iOS-only in v1).
 *
 * `syncPush()` runs after sign-in / `bootstrap()`, whenever the app comes to the
 * foreground and when Expo hands out a new token: it asks the station whether it
 * pushes at all (`GET` — 404 = an older server, `enabled: false` = switched off
 * there; both hide every push entry), and, once the member has allowed notifications
 * and has not switched them off for this station, gets the Expo token and registers
 * it (`PUT` — which also refreshes `last_seen_at`; a device unseen for 90 days stops
 * receiving). It never asks the system for permission: that is the soft ask's job
 * (./soft-ask.ts) or the member's, in Settings → 通知.
 *
 * Every station the member signs in to registers this phone on its own; a station
 * that is not active keeps its registration and keeps pushing (a tap switches there,
 * ./handler.ts). What survives restarts lives in prefs (`push_stations`): per station
 * the device id it gave us and whether the member switched pushes off there.
 *
 * Sign-out and removing a station unregister first (best effort — an offline phone
 * stays registered until another account signs in on it or 90 days pass, spec R4).
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { create } from 'zustand';
import type { PushDeviceView, PushPrefs } from '../shared/push';
import { listPushDevices, registerPushDevice, unregisterPushDevice, updatePushPrefs } from '../api/push';
import { loadPref, readStationTokens, savePref } from '../api/token-storage';
import { useAuth } from '../store/auth';
import { useStations, type StationRecord } from '../store/stations';
import type { PushPermission } from './model';

/** The station's stance: not asked yet · an older server (404) · switched off there · pushing. */
export type PushSupport = 'unknown' | 'unsupported' | 'disabled' | 'enabled';

export const PUSH_PLATFORM_READY = Platform.OS === 'ios';

interface StationPush {
  /** The id the station gave this phone. */
  deviceId?: string;
  /** The member switched pushes off for this station on this phone. */
  off?: boolean;
}

const STATIONS_PREF = 'push_stations';

async function loadStationPush(): Promise<Record<string, StationPush>> {
  try {
    const raw = await loadPref(STATIONS_PREF);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, StationPush>)
      : {};
  } catch {
    return {};
  }
}

async function patchStationPush(stationId: string, patch: StationPush | null): Promise<void> {
  const all = await loadStationPush();
  if (patch === null) delete all[stationId];
  else all[stationId] = { ...all[stationId], ...patch };
  await savePref(STATIONS_PREF, JSON.stringify(all));
}

function projectId(): string | null {
  const id = (Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined)?.eas?.projectId;
  return typeof id === 'string' && id ? id : null;
}

function toPermission(status: Notifications.NotificationPermissionsStatus): PushPermission {
  const ios = status.ios?.status;
  if (ios !== undefined) {
    if (ios === Notifications.IosAuthorizationStatus.NOT_DETERMINED) return 'undetermined';
    if (ios === Notifications.IosAuthorizationStatus.DENIED) return 'denied';
    return 'granted'; // authorized, provisional, ephemeral
  }
  if (status.granted) return 'granted';
  return status.status === 'undetermined' ? 'undetermined' : 'denied';
}

interface PushState {
  /** For the active station + account. */
  support: PushSupport;
  permission: PushPermission;
  /** This phone's registration on the active station (null: none / switched off / not allowed). */
  device: PushDeviceView | null;
  /** The member switched pushes off for the active station on this phone. */
  off: boolean;
  /** The last registration attempt failed on this phone (no Expo token — simulator without APNs, offline). */
  tokenFailed: boolean;
}

export const usePush = create<PushState>(() => ({
  support: 'unknown',
  permission: 'undetermined',
  device: null,
  off: false,
  tokenFailed: false,
}));

/** Bumped by every sync: an answer to a superseded one (the station changed meanwhile) is dropped. */
let syncGeneration = 0;

/** The station + account a sync started for, still current? */
function sameIdentity(stationId: string, userId: string): boolean {
  return useStations.getState().activeId === stationId && useAuth.getState().user?.id === userId;
}

export async function readPermission(): Promise<PushPermission> {
  if (!PUSH_PLATFORM_READY) return 'denied';
  try {
    return toPermission(await Notifications.getPermissionsAsync());
  } catch {
    return 'denied';
  }
}

let syncing: Promise<void> | null = null;
let syncAgain = false;

/**
 * Bring the active station's registration up to date (see the header). Never prompts,
 * never throws. One at a time: calls made while one runs share it and run it once more
 * after (foreground, the Settings page and a sign-in often ask in the same moment).
 */
export function syncPush(): Promise<void> {
  if (!PUSH_PLATFORM_READY) return Promise.resolve();
  if (syncing) {
    syncAgain = true;
    return syncing;
  }
  syncing = (async () => {
    try {
      do {
        syncAgain = false;
        await syncOnce();
      } while (syncAgain);
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

/**
 * Expo reports the device token every time it is fetched — including by our own
 * `getExpoPushTokenAsync` — so only a token that really changed asks for a sync
 * (re-syncing on every report fetched it again, and again: a loop).
 */
let lastDeviceToken: string | null = null;
export function onDeviceTokenReported(token: Notifications.DevicePushToken): void {
  const value = typeof token.data === 'string' ? token.data : JSON.stringify(token.data);
  if (value === lastDeviceToken) return;
  const first = lastDeviceToken === null;
  lastDeviceToken = value;
  // the first report is the token the running sync is registering
  if (!first) void syncPush();
}

async function syncOnce(): Promise<void> {
  const generation = ++syncGeneration;
  const { user, loading } = useAuth.getState();
  const stationId = useStations.getState().activeId;
  if (loading || !user || !stationId) {
    usePush.setState({ support: 'unknown', device: null, off: false, tokenFailed: false });
    return;
  }
  const current = () => generation === syncGeneration && sameIdentity(stationId, user.id);
  const [permission, listed, saved] = await Promise.all([readPermission(), listPushDevices(), loadStationPush()]);
  if (!current()) return;
  const record = saved[stationId] ?? {};
  if (listed === null) {
    // offline / a hiccup: keep what we knew
    usePush.setState({ permission, off: !!record.off });
    return;
  }
  if (listed === 'unsupported' || !listed.enabled) {
    usePush.setState({
      support: listed === 'unsupported' ? 'unsupported' : 'disabled',
      permission,
      device: null,
      off: !!record.off,
    });
    return;
  }
  const known = listed.devices.find((device) => device.id === record.deviceId) ?? null;
  usePush.setState({ support: 'enabled', permission, off: !!record.off, device: record.off ? null : known });
  if (permission !== 'granted' || record.off) return;

  const project = projectId();
  if (!project) return;
  let token: string;
  try {
    token = (await Notifications.getExpoPushTokenAsync({ projectId: project })).data;
  } catch {
    if (current()) usePush.setState({ tokenFailed: true });
    return;
  }
  if (!current()) return;
  const registered = await registerPushDevice({ token, platform: 'ios', project_id: project, client_ref: stationId });
  if (!current() || registered === null) return;
  if (registered === 'unsupported' || !registered.enabled || !registered.device) {
    usePush.setState({ support: registered === 'unsupported' ? 'unsupported' : 'disabled', device: null });
    return;
  }
  usePush.setState({ device: registered.device, tokenFailed: false });
  if (registered.device.id !== record.deviceId) await patchStationPush(stationId, { deviceId: registered.device.id });
}

/** Ask the system (after the soft ask, or from Settings) and register on success. */
export async function requestPushPermission(): Promise<PushPermission> {
  if (!PUSH_PLATFORM_READY) return 'denied';
  let permission: PushPermission;
  try {
    permission = toPermission(
      await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } }),
    );
  } catch {
    permission = 'denied';
  }
  usePush.setState({ permission });
  if (permission === 'granted') await syncPush();
  return permission;
}

/** The member's per-station switch (Settings → 通知): off unregisters this phone there, on registers it again. */
export async function setPushOff(off: boolean): Promise<boolean> {
  const stationId = useStations.getState().activeId;
  if (!stationId) return false;
  if (off) {
    const device = usePush.getState().device;
    if (device && !(await unregisterPushDevice(device.id))) return false;
    await patchStationPush(stationId, { off: true });
    usePush.setState({ off: true, device: null });
    return true;
  }
  await patchStationPush(stationId, { off: false });
  usePush.setState({ off: false });
  const permission = usePush.getState().permission;
  if (permission === 'undetermined') await requestPushPermission();
  else await syncPush();
  return true;
}

/** Change switches of this phone's registration on the active station. */
export async function setPushPrefs(prefs: Partial<PushPrefs>): Promise<boolean> {
  const device = usePush.getState().device;
  if (!device) return false;
  usePush.setState({ device: { ...device, prefs: { ...device.prefs, ...prefs } } });
  const saved = await updatePushPrefs(device.id, prefs);
  usePush.setState({ device: saved ?? device });
  return saved !== null;
}

/** How long sign-out / removing a station waits for the station to unregister this phone. */
const UNREGISTER_WAIT_MS = 1500;

/**
 * Sign-out / removing the active station: unregister there while its session still
 * works. The request starts at once (call before the tokens go); resolves when it
 * settled or after UNREGISTER_WAIT_MS, whichever comes first — never blocks the exit.
 */
export function unregisterActive(): Promise<void> {
  const stationId = useStations.getState().activeId;
  const device = usePush.getState().device;
  usePush.setState({ device: null, support: 'unknown' });
  if (!PUSH_PLATFORM_READY || !stationId || !device) return Promise.resolve();
  const settled = unregisterPushDevice(device.id)
    .then(() => patchStationPush(stationId, { deviceId: undefined }))
    .catch(() => undefined);
  return Promise.race([settled, new Promise<void>((resolve) => setTimeout(resolve, UNREGISTER_WAIT_MS))]);
}

/**
 * Removing a station that is not the active one: one last call to it, with its own
 * stored session. Resolves within UNREGISTER_WAIT_MS whatever the station does.
 */
export function unregisterStation(station: StationRecord): Promise<void> {
  if (!PUSH_PLATFORM_READY) return Promise.resolve();
  return Promise.race([
    unregisterStationNow(station),
    new Promise<void>((resolve) => setTimeout(resolve, UNREGISTER_WAIT_MS)),
  ]);
}

async function unregisterStationNow(station: StationRecord): Promise<void> {
  const record = (await loadStationPush())[station.id];
  await patchStationPush(station.id, null);
  if (!record?.deviceId) return;
  const { access, refresh } = await readStationTokens(station.id);
  const remove = (token: string) =>
    fetch(`${station.baseUrl}/api/auth/me/push-devices/${encodeURIComponent(record.deviceId!)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  try {
    const first = access ? await remove(access) : null;
    if ((!first || first.status === 401) && refresh) {
      // the access token expired: one refresh for this last call (the station is going anyway)
      const refreshed = await fetch(`${station.baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      });
      const data = refreshed.ok ? ((await refreshed.json()) as { accessToken?: unknown }) : {};
      if (typeof data.accessToken === 'string') await remove(data.accessToken);
    }
  } catch {
    // best effort (spec R4)
  }
}
