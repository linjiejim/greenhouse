/**
 * Unauthenticated paths contributed by extensions (OAuth callbacks, webhooks).
 * Kept in its own module so `auth/middleware.ts` can consult it without
 * importing the extension list (which imports route modules that import the
 * middleware — a cycle).
 */
const exact = new Set<string>();
const prefixes: string[] = [];

export function registerPublicPaths(paths: { exact?: string[]; prefixes?: string[] }): void {
  for (const p of paths.exact ?? []) exact.add(p);
  for (const p of paths.prefixes ?? []) if (!prefixes.includes(p)) prefixes.push(p);
}

export function isExtensionPublicPath(path: string): boolean {
  if (exact.has(path)) return true;
  return prefixes.some((prefix) => path.startsWith(prefix));
}

export function _resetExtensionPublicPaths(): void {
  exact.clear();
  prefixes.length = 0;
}
