/**
 * The seam to the desktop shell (apps/desktop, Tauri). The same bundle runs in browsers and
 * in the shell, so everything here is detected at run time and does nothing in a browser.
 * The shell injects both globals before any script runs.
 */

interface TauriInternals {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
    /** The server this desktop app talks to (apps/desktop/src-tauri/src/settings.rs). */
    __GREENHOUSE_DESKTOP_API_BASE__?: string;
  }
}

export type WebUpdateResult =
  | { status: 'staged'; version: string; downloaded: boolean }
  | { status: 'up_to_date' }
  | { status: 'needs_newer_shell'; required: string };
export type ShellUpdatePreparation = { status: 'ready'; version: string } | { status: 'up_to_date' };
export type ShellUpdateResult = { status: 'installed'; version: string } | { status: 'up_to_date' };

/** The shell commands this bundle calls; names and shapes mirror src-tauri/src/commands. */
interface Commands {
  desktop_mark_boot_ok: { args: undefined; result: void };
  desktop_log: { args: { level: 'info' | 'warn' | 'error'; message: string }; result: void };
  desktop_check_web_update: { args: undefined; result: WebUpdateResult };
  desktop_prepare_shell_update: { args: undefined; result: ShellUpdatePreparation };
  desktop_install_shell_update: { args: undefined; result: ShellUpdateResult };
  desktop_restart: { args: undefined; result: void };
  desktop_hide_quick_window: { args: undefined; result: void };
  desktop_hide_selection_bar: { args: undefined; result: void };
}

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;
}

/** The API origin when this page runs in the shell; empty in a browser, where the API is same-origin. */
export function desktopApiBase(): string {
  if (!isDesktop()) return '';
  return (window.__GREENHOUSE_DESKTOP_API_BASE__ ?? '').trim().replace(/\/+$/, '');
}

export function invokeDesktop<C extends keyof Commands>(
  command: C,
  ...[args]: Commands[C]['args'] extends undefined ? [] : [Commands[C]['args']]
): Promise<Commands[C]['result']> {
  const internals = typeof window === 'undefined' ? undefined : window.__TAURI_INTERNALS__;
  if (!internals) return Promise.reject(new Error(`${command} needs the desktop app`));
  return internals.invoke(command, args ?? {}) as Promise<Commands[C]['result']>;
}

/** Writes to the shell's log file; a packaged app has no devtools. Never throws. */
export function desktopLog(level: 'info' | 'warn' | 'error', message: string): void {
  if (!isDesktop()) return;
  invokeDesktop('desktop_log', { level, message }).catch(() => undefined);
}
