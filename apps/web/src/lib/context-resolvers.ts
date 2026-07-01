/**
 * Fork extension point for Global-Agent URL→PageContext resolution — the ONLY
 * file (plus the fork's page code) needed to give a private page an agent context.
 *
 * Upstream (greenhouse) ships this EMPTY. `resolveUrlContext()` in
 * agent-context.tsx consults this registry for any route its core switch doesn't
 * handle, so a fork maps its private routes (e.g. '#/crm/...') to a PageContext
 * WITHOUT editing agent-context.tsx. `PageContext.type` accepts fork type strings
 * (see the union's `(string & {})` member), so no central union edit is needed
 * either.
 *
 * Fork example (call once at app startup, e.g. from the fork's page module):
 *
 *   registerUrlContextResolver('crm', (subPath, params) => ({
 *     type: 'crm', module: subPath || params.get('module') || undefined,
 *   }));
 */

import type { PageContext } from '../components/agent-context';

export type UrlContextResolver = (subPath: string, params: URLSearchParams) => PageContext | null;

const resolvers = new Map<string, UrlContextResolver>();

/** Register a URL→context resolver for a top-level route (e.g. 'crm'). */
export function registerUrlContextResolver(route: string, resolver: UrlContextResolver): void {
  resolvers.set(route, resolver);
}

/** Resolve a fork route's context, or null if no fork registered that route. */
export function resolveExtraUrlContext(route: string, subPath: string, params: URLSearchParams): PageContext | null {
  return resolvers.get(route)?.(subPath, params) ?? null;
}
