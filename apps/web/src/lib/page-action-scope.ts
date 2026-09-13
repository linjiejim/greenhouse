/**
 * Page action scope — binds browser Client Actions to the route instance that
 * advertised them. A later route must never inherit an earlier page's handlers.
 */

interface PageActionScopeState {
  route: string;
  sequence: number;
  scopeId: string;
}

const GLOBAL_KEY = '__greenhousePageActionScopeV1';
const scopeState: PageActionScopeState =
  ((globalThis as Record<string, unknown>)[GLOBAL_KEY] as PageActionScopeState) ??
  ((globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
    route: '',
    sequence: 0,
    scopeId: '',
  });

/**
 * The route identity a scope is bound to: path only, no query string.
 *
 * Query params annotate the page instance; they do not replace it. Chat writes
 * `#/chat?session=<id>` mid-turn via `replaceState` as soon as a new session is
 * created, and counting that as a different route rotated the scope out from
 * under an in-flight turn — every remaining client action of that turn was then
 * refused, with no way to recover (the sequence only ever counts up, so even
 * navigating back yields a new id).
 */
function routeKey(hash: string): string {
  return hash.replace(/^#\/?/, '').replace(/#.*$/, '').replace(/\?.*$/, '') || 'chat';
}

export function pageActionScopeId(hash = window.location.hash || '#/chat'): string {
  const normalized = routeKey(hash);
  if (scopeState.route !== normalized) {
    scopeState.route = normalized;
    scopeState.sequence += 1;
    scopeState.scopeId = `page:${scopeState.sequence}:${normalized}`;
  }
  return scopeState.scopeId;
}

export function isPageActionScopeActive(scopeId: string, hash = window.location.hash || '#/chat'): boolean {
  return pageActionScopeId(hash) === scopeId;
}
