/**
 * Hot-update boot handshake.
 *
 * The desktop shell arms a watchdog when it boots a staged web bundle: if the web
 * app never reports back, the next launch rolls back to the embedded baseline (see
 * `apps/desktop/src-tauri/src/bundle.rs`). That's the safety net that makes it
 * reasonable to ship web changes as hot updates at all — a bad bundle costs one
 * restart instead of bricking everyone's app.
 *
 * Reporting from a mount effect (not module scope) is deliberate: it means React
 * actually rendered, so a bundle that parses but crashes on render still rolls back.
 */

import { invokeDesktop, isDesktop } from './bridge';

let reported = false;

export function reportDesktopBootOk(): void {
  if (reported || !isDesktop()) return;
  reported = true;
  invokeDesktop('desktop_mark_boot_ok').catch((err) => {
    // Non-fatal: worst case the shell rolls back a bundle that was actually fine.
    // Failing loudly here would be worse — it'd break a session that's working.
    console.warn('[desktop] boot handshake failed', err);
  });
}
