import type { FilterPillItem } from '../components/ui';

export type AssetScope = 'mine' | 'shared' | 'team';

/** Asset workspaces always open on the caller's own records, including for super. */
export const DEFAULT_ASSET_SCOPE: AssetScope = 'mine';

/** Shared scope-tab contract: Team is an administration view, never a member tab. */
export function assetScopeItems(
  isSuper: boolean,
  labels: { mine: string; shared: string; team: string },
): FilterPillItem[] {
  return [
    { key: 'mine', label: labels.mine },
    { key: 'shared', label: labels.shared },
    ...(isSuper ? [{ key: 'team', label: labels.team }] : []),
  ];
}

export function filterAutomationsByScope<T extends { user_id: string }>(
  items: T[],
  viewerId: string | undefined,
  scope: AssetScope,
): T[] {
  if (scope === 'shared') return [];
  return items.filter((item) => (scope === 'mine' ? item.user_id === viewerId : item.user_id !== viewerId));
}
