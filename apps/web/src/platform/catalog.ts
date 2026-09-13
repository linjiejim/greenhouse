/**
 * Permission-aware Platform catalog contracts and pure presentation helpers.
 *
 * Runtime state belongs to stores/platform-store.ts; this module deliberately
 * stays free of React and network concerns.
 */

import { DEFAULT_WORKBENCH_CONFIG, parseWorkbenchConfig, type WorkbenchConfig } from '@greenhouse/types/workbench';
import {
  BookOpen,
  Building2,
  FolderKanban,
  LayoutGrid,
  Package,
  Sprout,
  Table2,
  Users,
  type LucideIcon,
} from '../lib/icons';

export interface PlatformModule {
  id: string;
  title: string;
  description?: string;
  icon?: string;
}

export interface PlatformAction {
  id: string;
  title: string;
  module: string;
  entity?: string;
  kind: 'query' | 'command';
  capability: string;
  risk: 'read' | 'low' | 'medium' | 'high' | 'destructive';
}

export interface PlatformNavigationItem {
  id: string;
  title: string;
  module: string;
  path: string;
  view?: string;
  capability?: string;
}

export interface PlatformApplication {
  id: string;
  version: string;
  title: string;
  description?: string;
  modules: Record<string, PlatformModule>;
  actions: Record<string, PlatformAction>;
  navigation: PlatformNavigationItem[];
  capabilities: string[];
}

/**
 * Workbench config shape comes from `@greenhouse/types/workbench` — the same parser
 * the API validator and the database service run, so the three cannot drift
 * (spec D6). Re-exported here so page code keeps importing from one place.
 */
export type WorkbenchPreferences = WorkbenchConfig;
export const DEFAULT_WORKBENCH_PREFERENCES: WorkbenchConfig = { ...DEFAULT_WORKBENCH_CONFIG };

/**
 * Defensive client-side normalization: shape only.
 *
 * Application visibility is filtered server-side on read, so this no longer
 * re-derives it — dropping IDs here as well would just be a second, weaker copy
 * of an authorization decision the browser can't make.
 */
export function normalizeWorkbenchPreferences(input: unknown): WorkbenchConfig {
  return parseWorkbenchConfig(input);
}

export function orderPlatformApplications(
  applications: readonly PlatformApplication[],
  preferences: WorkbenchPreferences,
): PlatformApplication[] {
  const order = new Map(preferences.appOrder.map((appId, index) => [appId, index]));
  return [...applications].sort((left, right) => {
    const leftIndex = order.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = order.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.title.localeCompare(right.title);
  });
}

export function platformApplicationHref(application: PlatformApplication): string | null {
  // Complex application UI stays host-owned. Adding a new web application
  // requires a deliberate route registration here; Agent/MCP-only apps remain
  // valid catalog entries without producing a broken browser link.
  if (!['projects', 'knowledge', 'tables'].includes(application.id)) return null;
  const path = application.navigation[0]?.path;
  if (!path || !path.startsWith('/')) return null;
  return `#${path}`;
}

const ICONS: Record<string, LucideIcon> = {
  BookOpen,
  Building2,
  FolderKanban,
  LayoutGrid,
  Package,
  Sprout,
  Table2,
  Users,
};

export function platformApplicationIcon(application: PlatformApplication): LucideIcon {
  const firstModule = Object.values(application.modules)[0];
  return (firstModule?.icon && ICONS[firstModule.icon]) || LayoutGrid;
}

export const PRIMARY_NAV_APPLICATION_IDS = ['knowledge', 'projects', 'tables'] as const;

/**
 * Stable shell tabs are deliberately separate from personal workbench order,
 * pins, and hidden cards. Authorization still comes exclusively from the
 * server-filtered catalog; this function only chooses which authorized apps
 * receive a permanent top-level tab.
 */
export function selectPrimaryNavigationApplications(
  applications: readonly PlatformApplication[],
): PlatformApplication[] {
  const byId = new Map(
    applications
      .filter((application) => platformApplicationHref(application))
      .map((application) => [application.id, application]),
  );
  return PRIMARY_NAV_APPLICATION_IDS.flatMap((appId) => {
    const application = byId.get(appId);
    return application ? [application] : [];
  });
}
