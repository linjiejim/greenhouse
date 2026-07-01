/**
 * Fork extension point for public (auth-skipped) paths.
 *
 * Upstream ships EMPTY. `isPublicPath()` in middleware.ts consults these, so a
 * fork's OAuth redirect callbacks (Feishu / Gmail / Outlook) — which arrive
 * WITHOUT an Authorization header — can bypass the global auth middleware WITHOUT
 * editing middleware.ts.
 *
 * SECURITY-SENSITIVE: anything listed here is reachable UNAUTHENTICATED. Keep it
 * to OAuth callback endpoints that carry their own `state`/code verification. A
 * guard test pins these empty upstream so an OSS build never ships an open path.
 *
 * Fork example (in the fork's copy of this file):
 *   export const EXTENSION_PUBLIC_PATHS: string[] = ['/api/providers/feishu/callback'];
 *   export const EXTENSION_PUBLIC_PATH_PREFIXES: string[] = ['/api/email/oauth/'];
 */

/** Exact public paths contributed by a downstream fork. Empty upstream. */
export const EXTENSION_PUBLIC_PATHS: string[] = [];

/** Public path prefixes (startsWith) contributed by a downstream fork. Empty upstream. */
export const EXTENSION_PUBLIC_PATH_PREFIXES: string[] = [];
