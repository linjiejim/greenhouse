/**
 * Desktop integration entry point.
 *
 * `initDesktop()` is called once from `app.tsx` and is a no-op in a browser, which
 * is what keeps one bundle serving both. Everything it wires up is additive: the web
 * app works identically with none of it running.
 */

import { reportDesktopBootOk } from './boot';
import { isDesktop } from './bridge';
import { getCapabilities } from './capabilities';
import { listenForHandoff } from './handoff';
import { initDesktopLogging } from './logging';
import { registerDesktopActions } from './native-actions';
import { listenForDesktopPreferences } from './preferences';
import { initSelectionPolicy } from './selection-policy';
import { initShortcuts } from './shortcuts';
import { listenForTrayActions } from './tray-menu';
import { startUpdateChecks } from './updates';
import { initZoom } from './zoom';

export { isDesktop, isMacDesktop, invokeDesktop, onDesktopEvent, DesktopUnavailableError } from './bridge';
export {
  getCapabilities,
  peekCapabilities,
  onCapabilitiesChange,
  requestPermission,
  explainAvailability,
} from './capabilities';
export { captureToFile, captureAndUpload } from './capture';
export { checkForWebUpdate, checkForWebUpdateManually, restartApp, startUpdateChecks } from './updates';
export type * from './types';

let teardown: (() => void) | null = null;

/** Wire up desktop-only behaviour. Safe to call more than once. */
export function initDesktop(): void {
  if (!isDesktop() || teardown) return;

  // First, so anything that fails below is actually recorded somewhere.
  const stopLogging = initDesktopLogging();

  const unregisterActions = registerDesktopActions();

  // Warm the capability cache so the first UI that gates on it doesn't flicker.
  void getCapabilities();

  // Event subscriptions resolve asynchronously; hold the promises so teardown can
  // await them rather than leaking a listener registered after unmount.
  const shortcuts = initShortcuts();
  const handoff = listenForHandoff();
  const preferences = listenForDesktopPreferences();
  const selectionPolicy = initSelectionPolicy();
  const trayActions = listenForTrayActions();
  const zoom = initZoom();

  // Without this the hot-update engine never runs: nothing else asks it to.
  const stopUpdateChecks = startUpdateChecks();

  // Permissions are granted outside this app, so the answer goes stale whenever the
  // user has been away — refresh when they come back rather than on a timer.
  const refresh = () => void getCapabilities({ refresh: true });
  window.addEventListener('focus', refresh);

  teardown = () => {
    unregisterActions();
    void shortcuts.then((off) => off());
    void handoff.then((off) => off());
    void preferences.then((off) => off());
    void selectionPolicy.then((off) => off());
    void trayActions.then((off) => off());
    void zoom.then((off) => off());
    stopUpdateChecks();
    stopLogging();
    window.removeEventListener('focus', refresh);
    teardown = null;
  };
}

export { reportDesktopBootOk };
