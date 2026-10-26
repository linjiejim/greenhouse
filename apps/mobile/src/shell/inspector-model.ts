/** A bounded inspector stack follows the root router; it never owns a second transcript. */
import { sheetDepth } from './object-ref';
export const inspectorRoute = (name: string) => name.startsWith('sheet/');
export const inspectorCount = sheetDepth;
export const boundedInspectorWidth = (width: number) => Math.max(360, Math.min(520, width));
/** Keep the current route key/scroll state and discard the inspector history on promotion. */
export function promotedInspectorRoutes<T extends { name: string; params?: object }>(routes: readonly T[]): T[] {
  const current = routes.at(-1);
  if (!current) return [];
  const depth = inspectorCount(routes);
  let keep = routes.length - Math.max(1, depth);
  if (keep > 0 && (routes[keep - 1]?.params as { main?: string } | undefined)?.main === '1') keep--;
  return [...routes.slice(0, keep), { ...current, params: { ...current.params, main: '1' } }];
}
