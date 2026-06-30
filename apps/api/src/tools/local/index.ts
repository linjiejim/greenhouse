/**
 * Local Tools — placeholder surface for client-executed agent tools.
 *
 * The Desktop OS-level local tools (file/shell/clipboard/compute/skill) were
 * removed when the desktop shell was dropped. The browser still executes UI
 * "client actions" via the same bridge plumbing (see tools/client-actions.ts +
 * tools/local/bridge.ts), so the bridge and the pending-result registry remain.
 *
 * This module keeps exporting `LOCAL_TOOL_IDS` (now empty) and the tool-factory
 * entry points so existing call sites (agent.ts, agent-runtime/tool-resolution,
 * routes/chat.ts) keep compiling.
 */

// Marker convention lives in the kernel (the engine detects markers in the
// stream); re-exported here so existing tool-side imports keep working.
export { isLocalToolMarker, type LocalToolMarker } from '@greenhouse/agent-core';

// ─── Barrel Export ────────────────────────────────────────

/** All local (client-executed OS) tool IDs. Empty — none remain on the web app. */
export const LOCAL_TOOL_IDS = [] as const;

/** No server-side local tools remain. Kept for registry-registration call sites. */
export function createLocalTools(): Record<string, any> {
  return {};
}
