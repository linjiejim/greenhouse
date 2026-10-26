import { registeredApplicationRoute } from '../lib/extension-registries';
/**
 * Permission-aware Platform catalog contracts and pure presentation helpers.
 *
 * Runtime state belongs to stores/platform-store.ts; this module deliberately
 * stays free of React and network concerns.
 */

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

/** Applications in a stable, readable order (by title). */
export function orderPlatformApplications(applications: readonly PlatformApplication[]): PlatformApplication[] {
  return [...applications].sort((left, right) => left.title.localeCompare(right.title));
}

export function platformApplicationHref(application: PlatformApplication): string | null {
  // Complex application UI stays host-owned. Adding a new web application
  // requires a deliberate route registration here; Agent/MCP-only apps remain
  // valid catalog entries without producing a broken browser link.
  const contributed = registeredApplicationRoute(application.id);
  if (contributed) return contributed;
  if (!['knowledge'].includes(application.id)) return null;
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
