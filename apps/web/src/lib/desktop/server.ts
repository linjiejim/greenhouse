/**
 * Which server an unlocked desktop shell talks to. The shell owns the address
 * (apps/desktop/src-tauri/src/settings.rs) and injects it before any script runs, so a new
 * address takes effect only in a new process: desktop_set_api_base reloads the window, but
 * the reload re-runs the bootstrap script the window was built with. A switch therefore
 * leaves a marker, and the page that loads after the reload restarts the app.
 */

import { useQuery } from '@tanstack/react-query';
import { API_VERSION } from '@greenhouse/contract';
import { desktopApiBase, invokeDesktop, isDesktop, type DesktopSettings } from './shell';

/** Where an unlocked shell starts: the API's dev port (settings.rs LOCAL_API_BASE_URL). */
export const LOCAL_SERVER = 'http://localhost:3000';
/** A server was chosen on this install; first launch asks until then. */
const CHOSEN_KEY = 'greenhouse.desktop.server';
/** A switch waiting for the restart that loads the new address. */
const SWITCH_KEY = 'greenhouse.desktop.server-switch';
const CHECK_TIMEOUT_MS = 10_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1']);

export type ServerAddress = { ok: true; origin: string } | { ok: false; error: 'invalid' | 'insecure' };
export type ServerCheck =
  | { ok: true; name: string }
  | { ok: false; error: 'unreachable' | 'not_greenhouse' | 'too_old' };

/**
 * A bare origin, the same rule as the shell's normalize_api_base. A missing scheme means
 * https (http for this computer); plain http only reaches this computer, because the app's
 * content policy blocks it elsewhere.
 */
export function parseServerAddress(raw: string): ServerAddress {
  let value = raw.trim().replace(/\/+$/, '');
  if (!value) return { ok: false, error: 'invalid' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const host = value.split(/[/:?#]/, 1)[0]!.toLowerCase();
    value = `${host === 'localhost' || host === '127.0.0.1' ? 'http' : 'https'}://${value}`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: 'invalid' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'invalid' };
  if (!url.hostname || url.username || url.password) return { ok: false, error: 'invalid' };
  if (url.pathname !== '/' || url.search || url.hash) return { ok: false, error: 'invalid' };
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) return { ok: false, error: 'insecure' };
  return { ok: true, origin: url.origin };
}

/** Asks the server's public bootstrap whether it is a Greenhouse this app can use. */
export async function checkServer(origin: string, send: typeof fetch = fetch): Promise<ServerCheck> {
  let response: Response;
  try {
    response = await send(`${origin}/api/bootstrap`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: 'unreachable' };
  }
  if (!response.ok) return { ok: false, error: 'not_greenhouse' };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: 'not_greenhouse' };
  }
  const { api_version: version, name } = (body ?? {}) as { api_version?: unknown; name?: unknown };
  if (typeof version !== 'number') return { ok: false, error: 'not_greenhouse' };
  if (version < API_VERSION) return { ok: false, error: 'too_old' };
  return { ok: true, name: typeof name === 'string' ? name : '' };
}

/** The shell's server setting; undefined in a browser and while loading. */
export function useDesktopSettings() {
  return useQuery({
    queryKey: ['desktop', 'settings'],
    queryFn: () => invokeDesktop('desktop_get_settings'),
    enabled: isDesktop(),
    staleTime: Infinity,
  });
}

/** First launch of an unlocked shell: nothing chosen yet and still on the dev default. */
export function isFirstLaunch(settings: DesktopSettings): boolean {
  return !settings.apiBaseLocked && settings.apiBaseUrl === LOCAL_SERVER && read(CHOSEN_KEY) === null;
}

/**
 * Saves the server and restarts into it. Sign out first: the session belongs to the old
 * server. Resolves only if the shell refused; otherwise the page goes away.
 */
export async function switchServer(origin: string): Promise<void> {
  // Written first: the shell's reload can end this page before the call returns.
  const chosen = read(CHOSEN_KEY);
  write(SWITCH_KEY, origin);
  write(CHOSEN_KEY, origin);
  try {
    await invokeDesktop('desktop_set_api_base', { url: origin });
  } catch (error) {
    write(SWITCH_KEY, null);
    write(CHOSEN_KEY, chosen);
    throw error;
  }
  await invokeDesktop('desktop_restart');
}

/**
 * Called at start: finishes a switch the shell's reload interrupted by restarting once. The
 * page still renders, so a failed restart leaves a working app rather than a blank window.
 */
export function finishServerSwitch(): void {
  const pending = read(SWITCH_KEY);
  if (pending === null) return;
  write(SWITCH_KEY, null);
  if (pending !== desktopApiBase()) invokeDesktop('desktop_restart').catch(() => undefined);
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* Storage may be unavailable. */
  }
}
