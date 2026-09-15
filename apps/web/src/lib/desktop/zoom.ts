/**
 * Page zoom for the desktop shell.
 *
 * A browser hands you ⌘+ / ⌘- / ⌘0 for free; a Tauri webview does not. Tauri ships
 * a hotkey polyfill, but it is off by default and — the reason we don't just switch
 * it on — it keeps the level in a module-local variable, so every reload and every
 * hot update drops the user back to 100%. On Windows the same config flag maps to
 * WebView2's own zoom control instead, i.e. two platforms with different behaviour
 * and no shared level to persist.
 *
 * So the shell contributes only what a web page genuinely cannot do (the native
 * zoom call, granted by `core:webview:allow-set-webview-zoom`, and the View menu)
 * and this module owns everything else: the ladder of levels, the keyboard
 * fallback, and remembering the choice. Same split as `shortcuts.ts`.
 *
 * Two triggers, one ladder, no overlap in practice: on macOS the View menu claims
 * ⌘= / ⌘- / ⌘0 before the webview sees them, and the keydown handler below picks
 * up the shifted ⌘⇧+ that the menu's modifier set doesn't match. On Windows there
 * is no app menu at all, so the keydown handler is the only path.
 */

import { isDesktop, isMainWindow, onDesktopEvent } from './bridge';
import { DESKTOP_EVENT, type ZoomCommandEvent } from './types';

/**
 * Browser-like stops. Kept coarse on purpose — a 0.1 linear step is uselessly
 * small at 200% and jarring at 50%.
 */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const DEFAULT_ZOOM = 1;

/**
 * Not scoped to a user: zoom answers "how far away is this screen", which belongs
 * to the machine, not the account signed into it.
 */
const STORAGE_KEY = 'greenhouse:desktop-zoom:v1';

type ZoomCommand = ZoomCommandEvent['command'];

function nearestStepIndex(zoom: number): number {
  let best = 0;
  for (let i = 1; i < ZOOM_STEPS.length; i += 1) {
    if (Math.abs(ZOOM_STEPS[i] - zoom) < Math.abs(ZOOM_STEPS[best] - zoom)) best = i;
  }
  return best;
}

/** The next stop in/out from `current`, clamped at both ends of the ladder. */
export function stepZoom(current: number, direction: 'in' | 'out'): number {
  const next = nearestStepIndex(current) + (direction === 'in' ? 1 : -1);
  return ZOOM_STEPS[Math.min(Math.max(next, 0), ZOOM_STEPS.length - 1)];
}

/** Apply a command to a level. Pure, so the ladder is testable without a webview. */
export function applyZoomCommand(current: number, command: ZoomCommand): number {
  return command === 'reset' ? DEFAULT_ZOOM : stepZoom(current, command);
}

/**
 * Snap whatever is in storage onto the ladder. Anything unparseable or off-scale
 * falls back to 100% rather than being clamped: a corrupt value is not a hint
 * about what the user wanted, and a window stuck at an unreachable zoom would have
 * no way back except clearing storage.
 */
export function readStoredZoom(raw: string | null): number {
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed)) return DEFAULT_ZOOM;
  if (parsed < ZOOM_STEPS[0] || parsed > ZOOM_STEPS[ZOOM_STEPS.length - 1]) return DEFAULT_ZOOM;
  return ZOOM_STEPS[nearestStepIndex(parsed)];
}

/**
 * Which zoom command a keystroke means, or `null` for everything else.
 *
 * Deliberately not gated on the event target: browser zoom works while you're
 * typing in a text field, and so should this.
 */
export function matchZoomKey(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>): ZoomCommand | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  switch (event.key) {
    case '=':
    case '+':
      return 'in';
    case '-':
    case '_':
      return 'out';
    case '0':
      return 'reset';
    default:
      return null;
  }
}

let currentZoom = DEFAULT_ZOOM;

async function setWebviewZoom(zoom: number): Promise<void> {
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  await getCurrentWebview().setZoom(zoom);
}

async function commit(zoom: number): Promise<void> {
  await setWebviewZoom(zoom);
  currentZoom = zoom;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(zoom));
  } catch {
    // Private mode / quota. The zoom still applied for this session, which is the
    // part the user asked for; losing it on restart is not worth failing over.
  }
}

async function run(command: ZoomCommand): Promise<void> {
  const next = applyZoomCommand(currentZoom, command);
  if (next === currentZoom) return; // already at the end of the ladder
  await commit(next);
}

/**
 * Restore the persisted level and start handling zoom commands. Returns an
 * unsubscribe function; a no-op outside the desktop shell's main window.
 */
export async function initZoom(): Promise<() => void> {
  if (!isDesktop() || !(await isMainWindow())) return () => {};

  let stored = DEFAULT_ZOOM;
  try {
    stored = readStoredZoom(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Unreadable storage is the same as never having zoomed.
  }
  if (stored !== DEFAULT_ZOOM) {
    // Only call out when there's something to restore: on a shell too old to hold
    // the zoom permission this would warn on every single launch.
    await commit(stored).catch((err) => {
      console.warn('[desktop] could not restore zoom', err);
    });
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const command = matchZoomKey(event);
    if (!command) return;
    // The webview would otherwise also hand ⌘- and ⌘+ to its own (unpersisted)
    // handling on some platforms, leaving two levels fighting over one window.
    event.preventDefault();
    void run(command).catch((err) => {
      console.warn(`[desktop] zoom ${command} failed`, err);
    });
  };
  window.addEventListener('keydown', onKeyDown);

  const offMenu = await onDesktopEvent<ZoomCommandEvent>(DESKTOP_EVENT.zoom, (payload) => {
    void run(payload.command).catch((err) => {
      console.warn(`[desktop] zoom ${payload.command} failed`, err);
    });
  });

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    offMenu();
  };
}
