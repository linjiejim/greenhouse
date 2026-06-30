/**
 * Client Action Registry — the "hands" half of the agent's page awareness.
 *
 * Mirror of the context-provider registry (lib/context-registry.ts): where that lets a
 * page declare WHAT IT IS (so the agent can read it), this lets a page declare WHAT IT
 * CAN DO (so the agent can operate it). Pages register actions via the usePageActions
 * hook; the agent panel snapshots the serializable descriptors at send time and ships
 * them to the backend, which turns each into a tool. When the agent calls one, the
 * round-trip lands back here and runs the live `execute` handler in the browser.
 */

import type { ClientActionDescriptor } from '@greenhouse/types/api';

export interface RegisteredClientAction extends ClientActionDescriptor {
  /**
   * 'auto'    — run immediately (navigation, reading current view: low risk).
   * 'confirm' — ask the user before running (anything more intrusive).
   * Real data writes should NOT be client actions — keep them on the confirmed
   * server-side mutation tools. Default: 'auto'.
   */
  safety?: 'auto' | 'confirm';
  /** Runs in the browser. Return a JSON-serializable result the agent will see. */
  execute: (params: Record<string, unknown>) => unknown | Promise<unknown>;
}

// Backed by a single globalThis-scoped Map. The agent panel (eager entry chunk) and
// each page's usePageActions (lazy route chunks) import this module from *different*
// esbuild code-split chunks; esbuild can duplicate the module, giving each chunk its own
// closure. Pinning the Map to globalThis guarantees one shared registry regardless, so a
// lazily-registered action is always visible to the eager snapshot at send time.
const GLOBAL_KEY = '__greenhouseClientActionRegistry';
const registry: Map<string, RegisteredClientAction> =
  ((globalThis as Record<string, unknown>)[GLOBAL_KEY] as Map<string, RegisteredClientAction>) ??
  ((globalThis as Record<string, unknown>)[GLOBAL_KEY] = new Map<string, RegisteredClientAction>());

/** Register an action. Returns an unregister fn (call on unmount). */
export function registerClientAction(action: RegisteredClientAction): () => void {
  registry.set(action.name, action);
  return () => {
    // Only delete if it's still the same registration (guards against races where a
    // remount registered a newer handler before the old cleanup ran).
    if (registry.get(action.name) === action) registry.delete(action.name);
  };
}

export function getClientAction(name: string): RegisteredClientAction | undefined {
  return registry.get(name);
}

/** Snapshot the serializable descriptors to advertise to the agent for this turn. */
export function snapshotClientActions(): ClientActionDescriptor[] {
  return [...registry.values()].map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
}
