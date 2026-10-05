/**
 * Lazy loader for the noVNC client.
 *
 * noVNC (~200 KB with its decoders) is only needed by members who open a Bot's
 * computer, so it is never part of the main bundle: the first call dynamically
 * imports it and later calls reuse the same promise — the same shape as the
 * chart.js / mermaid loaders. A failed import (offline, stale deploy) clears
 * the cache so the next attempt retries instead of failing forever.
 *
 * Why not reuse something existing: the app has no remote-desktop viewer, and
 * an iframe-hosted noVNC page would need same-origin access to the token
 * (rejected for the same reason html-preview never gets `allow-same-origin`).
 */

import type { RfbConstructor } from './types';

let pending: Promise<RfbConstructor> | null = null;

export function loadRfb(): Promise<RfbConstructor> {
  if (!pending) {
    pending = import('@novnc/novnc')
      .then((mod) => mod.default)
      .catch((err: unknown) => {
        pending = null;
        throw err;
      });
  }
  return pending;
}
