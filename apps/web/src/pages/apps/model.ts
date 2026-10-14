import type { AppSpec } from '@greenhouse/contract';
export function pageDiff(before: AppSpec | undefined, after: AppSpec) {
  const old = new Map(before?.pages.map((p) => [p.id, p]) ?? []);
  const fresh = new Set(after.pages.map((p) => p.id));
  return {
    added: after.pages.filter((p) => !old.has(p.id)).length,
    removed: [...old.keys()].filter((id) => !fresh.has(id)).length,
    changed: after.pages.filter((p) => old.has(p.id) && JSON.stringify(p) !== JSON.stringify(old.get(p.id))).length,
    permissions: JSON.stringify(before?.roles ?? []) !== JSON.stringify(after.roles),
  };
}
export function move<T>(items: T[], index: number, by: -1 | 1): T[] {
  const next = index + by;
  if (next < 0 || next >= items.length) return items;
  const copy = [...items];
  [copy[index], copy[next]] = [copy[next]!, copy[index]!];
  return copy;
}
export const localId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 12);
