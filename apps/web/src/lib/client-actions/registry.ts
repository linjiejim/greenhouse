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
const GLOBAL_KEY = '__greenhouseScopedClientActionRegistryV2';
const registry: Map<string, Map<string, RegisteredClientAction>> = ((globalThis as Record<string, unknown>)[
  GLOBAL_KEY
] as Map<string, Map<string, RegisteredClientAction>>) ??
((globalThis as Record<string, unknown>)[GLOBAL_KEY] = new Map<string, Map<string, RegisteredClientAction>>());

/**
 * Non-page capabilities that should be advertised from every active page scope.
 *
 * These handlers belong to the app, not to a route — desktop native capture and
 * the browser bridge keep working no matter which page is showing — so
 * executor.ts deliberately does NOT expire them on navigation. Page actions
 * still do: a later route must never inherit an earlier page's handlers.
 *
 * The two rules have to agree, because `snapshotClientActions` advertises the
 * global set from every scope. While execution expired them with the page, a
 * long browsing turn advertised `browser_*` and then refused every call once
 * anything touched the URL — the model was told it had a capability that was
 * already gone.
 */
export const GLOBAL_CLIENT_ACTION_SCOPE = 'global:client-actions';

/** Register an action. Returns an unregister fn (call on unmount). */
export function registerClientAction(scopeId: string, action: RegisteredClientAction): () => void {
  const scope = registry.get(scopeId) ?? new Map<string, RegisteredClientAction>();
  scope.set(action.name, action);
  registry.set(scopeId, scope);
  return () => {
    // Only delete if it's still the same registration (guards against races where a
    // remount registered a newer handler before the old cleanup ran).
    if (scope.get(action.name) === action) scope.delete(action.name);
    if (scope.size === 0 && registry.get(scopeId) === scope) registry.delete(scopeId);
  };
}

export interface ResolvedClientAction {
  action: RegisteredClientAction;
  /** Where it was registered — 'page' expires with the route, 'global' does not. */
  origin: 'page' | 'global';
}

/**
 * Look an action up and report which registry it came from.
 *
 * The origin has to come from the lookup rather than from the name: a page may
 * register an action that shadows a global one, and that shadow is page-bound.
 */
export function resolveClientAction(scopeId: string, name: string): ResolvedClientAction | undefined {
  const pageAction = scopeId === GLOBAL_CLIENT_ACTION_SCOPE ? undefined : registry.get(scopeId)?.get(name);
  if (pageAction) return { action: pageAction, origin: 'page' };
  const globalAction = registry.get(GLOBAL_CLIENT_ACTION_SCOPE)?.get(name);
  return globalAction ? { action: globalAction, origin: 'global' } : undefined;
}

export function getClientAction(scopeId: string, name: string): RegisteredClientAction | undefined {
  return resolveClientAction(scopeId, name)?.action;
}

/** Snapshot the serializable descriptors to advertise to the agent for this turn. */
export function snapshotClientActions(scopeId: string): ClientActionDescriptor[] {
  const actions = new Map(registry.get(GLOBAL_CLIENT_ACTION_SCOPE) ?? []);
  if (scopeId !== GLOBAL_CLIENT_ACTION_SCOPE) {
    for (const [name, action] of registry.get(scopeId) ?? []) actions.set(name, action);
  }
  return [...actions.values()].map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
}
