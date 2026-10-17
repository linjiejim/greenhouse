/**
 * Desktop shell support, kept to what an installed shell needs to run this bundle: the API
 * origin and the server setting, API links, the boot handshake, hot updates and the log. Everything is a no-op in a
 * browser. Quick launch, the selection bar, the tray menu and capture come later (PRD §8.5).
 */

import { finishServerSwitch } from './server';
import { installApiUrls } from './urls';
import { startUpdateChecks } from './updates';
import { desktopApiBase, desktopLog, invokeDesktop, isDesktop } from './shell';

export { apiUrl } from './urls';
export { applyUpdate, checkForUpdates, useDesktopUpdate } from './updates';
export { isDesktop } from './shell';
export {
  checkServer,
  isFirstLaunch,
  parseServerAddress,
  switchServer,
  useDesktopSettings,
  type ServerCheck,
} from './server';

let started = false;
let bootReported = false;

/** Call once before the first render. Returns false in a satellite window, which must not render the app. */
export function initDesktop(): boolean {
  if (!isDesktop() || started) return true;
  started = true;

  // The shell opens these windows only when a bundle asks for them; this one does not yet.
  const hash = location.hash;
  if (hash.startsWith('#/desktop/')) {
    const hide = hash.startsWith('#/desktop/quick') ? 'desktop_hide_quick_window' : 'desktop_hide_selection_bar';
    invokeDesktop(hide).catch(() => undefined);
    return false;
  }

  finishServerSwitch();
  installApiUrls(desktopApiBase());
  window.addEventListener('error', (event) =>
    desktopLog('error', `${event.message} at ${event.filename}:${event.lineno}`),
  );
  window.addEventListener('unhandledrejection', (event) => desktopLog('error', `unhandled: ${String(event.reason)}`));
  startUpdateChecks();
  return true;
}

/**
 * Tells the shell this bundle rendered. A staged bundle that never reports is rolled back on
 * the next launch (apps/desktop/src-tauri/src/bundle.rs), so call it from a mount effect.
 */
export function reportBootOk(): void {
  if (bootReported || !isDesktop()) return;
  bootReported = true;
  invokeDesktop('desktop_mark_boot_ok').catch((error: unknown) =>
    desktopLog('warn', `[boot] handshake failed: ${String(error)}`),
  );
}
