/**
 * Desktop bridge — the single seam between the web app and the Tauri shell.
 *
 * The *same* bundle is served to browsers and to the desktop shell (that's what
 * makes hot updates work), so every native capability has to be feature-detected
 * at runtime rather than compiled in. Two rules follow from that:
 *
 *   1. Nothing here may throw or reach for a Tauri global at import time.
 *   2. `@tauri-apps/api` is loaded with a dynamic `import()`, so it lands in its own
 *      chunk that a browser session never fetches.
 *
 * Callers use `isDesktop()` to gate UI, and `invokeDesktop()` to actually call in.
 */

import type { DesktopArgs, DesktopCommand, DesktopResult } from './types';

/**
 * Tauri v2 injects `__TAURI_INTERNALS__` into every webview it owns — including
 * ones loading a custom scheme — before any app script runs. It's what
 * `@tauri-apps/api` itself checks, so it's the honest detection point.
 */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** The titlebar overlay is macOS-only, so web chrome only reserves traffic-light space there. */
export function isMacDesktop(): boolean {
  return isDesktop() && typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
}

/**
 * Shell events are broadcast to every window, so each handler has to decide
 * whether it's the one that should act. Without this, the quick-input and
 * selection-bar windows would each take the screenshot / apply the zoom too.
 */
export async function isMainWindow(): Promise<boolean> {
  if (!isDesktop()) return false;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow().label === 'main';
}

/** Thrown when native code is called from a plain browser session. */
export class DesktopUnavailableError extends Error {
  constructor(command: string) {
    super(`Native command "${command}" is only available in the Greenhouse desktop app`);
    this.name = 'DesktopUnavailableError';
  }
}

type TauriCore = typeof import('@tauri-apps/api/core');
type TauriEvent = typeof import('@tauri-apps/api/event');

let corePromise: Promise<TauriCore> | null = null;
let eventPromise: Promise<TauriEvent> | null = null;

function loadCore(): Promise<TauriCore> {
  corePromise ??= import('@tauri-apps/api/core');
  return corePromise;
}

function loadEvent(): Promise<TauriEvent> {
  eventPromise ??= import('@tauri-apps/api/event');
  return eventPromise;
}

/**
 * Call a native command. Throws `DesktopUnavailableError` in a browser — callers
 * that want a silent no-op should check `isDesktop()` first, so the failure mode
 * is a deliberate choice at each call site rather than a swallowed error here.
 */
export async function invokeDesktop<C extends DesktopCommand>(
  command: C,
  ...[args]: DesktopArgs<C> extends void ? [] : [DesktopArgs<C>]
): Promise<DesktopResult<C>> {
  if (!isDesktop()) throw new DesktopUnavailableError(command);
  const { invoke } = await loadCore();
  return invoke<DesktopResult<C>>(command, args as Record<string, unknown> | undefined);
}

/**
 * Subscribe to an event emitted by the shell. Resolves to an unsubscribe function;
 * in a browser it resolves to a no-op so callers don't need their own guard.
 */
export async function onDesktopEvent<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  const { listen } = await loadEvent();
  const unlisten = await listen<T>(event, (e) => handler(e.payload));
  return unlisten;
}
