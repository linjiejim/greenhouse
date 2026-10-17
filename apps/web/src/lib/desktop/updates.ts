/**
 * Hot updates for the desktop shell. The shell never checks on its own: this bundle asks it
 * to download the next web bundle (or, when that needs a newer shell, the shell update) and
 * offers a restart. Checks run 20 seconds after start, every 4 hours, and when the server
 * speaks a newer API than this page.
 */

import { useSyncExternalStore } from 'react';
import { desktopLog, invokeDesktop, isDesktop } from './shell';

export type DesktopUpdate =
  | { kind: 'none' }
  /** A web bundle is downloaded; a restart loads it. */
  | { kind: 'web'; version: string }
  /** A shell update is downloaded; installing it restarts the app. */
  | { kind: 'shell'; version: string }
  /** The next bundle needs a newer shell that could not be downloaded here. */
  | { kind: 'shell_required' };

const FIRST_CHECK_MS = 20_000;
const RECHECK_MS = 4 * 60 * 60 * 1000;

let state: DesktopUpdate = { kind: 'none' };
let checking: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

function set(next: DesktopUpdate) {
  state = next;
  listeners.forEach((listener) => listener());
}

export function currentDesktopUpdate(): DesktopUpdate {
  return state;
}

export function useDesktopUpdate(): DesktopUpdate {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, currentDesktopUpdate);
}

async function check(): Promise<void> {
  const web = await invokeDesktop('desktop_check_web_update');
  if (web.status === 'staged') return set({ kind: 'web', version: web.version });
  if (web.status !== 'needs_newer_shell') return;
  const shell = await invokeDesktop('desktop_prepare_shell_update');
  set(shell.status === 'ready' ? { kind: 'shell', version: shell.version } : { kind: 'shell_required' });
}

/** One check at a time; resolves false when it failed, and the reason goes to the shell's log. */
export function checkForUpdates(): Promise<boolean> {
  if (!isDesktop()) return Promise.resolve(false);
  checking ??= check()
    .then(
      () => true,
      (error: unknown) => {
        desktopLog('warn', `[update] check failed: ${String(error)}`);
        return false;
      },
    )
    .finally(() => {
      checking = null;
    });
  return checking;
}

export function startUpdateChecks(): () => void {
  if (!isDesktop()) return () => undefined;
  const first = setTimeout(() => void checkForUpdates(), FIRST_CHECK_MS);
  const every = setInterval(() => void checkForUpdates(), RECHECK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

/** Restarts into what was downloaded; a shell update is installed first. */
export async function applyUpdate(): Promise<void> {
  if (state.kind === 'shell') {
    const result = await invokeDesktop('desktop_install_shell_update');
    if (result.status !== 'installed') return set({ kind: 'shell_required' });
  } else if (state.kind !== 'web') return;
  await invokeDesktop('desktop_restart');
}

/** For tests. */
export function resetDesktopUpdate() {
  checking = null;
  set({ kind: 'none' });
}
