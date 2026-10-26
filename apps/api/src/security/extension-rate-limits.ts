/** Optional routes keep their existing admission limits without core path cases. */
export interface ExtensionRateLimit {
  path: string;
  windowMs: number;
  max: number;
  internalMax?: number;
}
let limits: readonly ExtensionRateLimit[] = [];
export function registerExtensionRateLimits(entries: readonly ExtensionRateLimit[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      !entry.path.startsWith('/api/') ||
      seen.has(entry.path) ||
      !Number.isInteger(entry.windowMs) ||
      entry.windowMs < 1 ||
      !Number.isInteger(entry.max) ||
      entry.max < 1 ||
      (entry.internalMax !== undefined && (!Number.isInteger(entry.internalMax) || entry.internalMax < 1))
    )
      throw new Error(`Invalid extension rate limit "${entry.path}"`);
    seen.add(entry.path);
  }
  limits = [...entries].sort((a, b) => b.path.length - a.path.length);
}
export function extensionRateLimit(path: string, internal = false): { windowMs: number; max: number } | null {
  const entry = limits.find((rule) => path === rule.path || path.startsWith(rule.path + '/'));
  return entry ? { windowMs: entry.windowMs, max: internal ? (entry.internalMax ?? entry.max) : entry.max } : null;
}
