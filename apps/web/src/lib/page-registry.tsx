/**
 * Fork extension point for top-level pages — the ONLY app-shell file a downstream
 * fork edits to add a private primary page (e.g. a CRM tab).
 *
 * Upstream ships this EMPTY. app.tsx consults getExtraPage()/extraPageKeys() for
 * routing + rendering, and both app.tsx (mobile) and app-sidebar.tsx (desktop)
 * append extraNavItems() to their main-nav lists — so a fork page routes,
 * renders, and gets a sidebar tab WITHOUT editing the render switch or nav
 * arrays. The page handles its own role gating in `render` (like core pages do).
 *
 * Fork example (in the fork's copy of this file):
 *   import { Users } from './icons';
 *   import { CrmPage } from '../pages/crm';
 *   export const EXTRA_PAGES: ExtraPage[] = [
 *     { key: 'crm', navLabel: 'CRM', navIcon: Users, showInNav: true,
 *       render: ({ subPath, isExternal }) => (isExternal ? null : <CrmPage subPath={subPath} />) },
 *   ];
 */

import type { ReactNode } from 'react';
import type { LucideIcon } from './icons';

export interface ExtraPageContext {
  subPath: string;
  params: URLSearchParams;
  userRole: string;
  isExternal: boolean;
}

export interface ExtraPageNavItem {
  key: string;
  label: string;
  icon: LucideIcon;
  visible: boolean;
}

export interface ExtraPage {
  /** Top-level route key, e.g. 'crm'. */
  key: string;
  /** Sidebar / mobile-nav label. Required (with navIcon) to appear in the nav. */
  navLabel?: string;
  navIcon?: LucideIcon;
  /** Show a main-nav entry for this page. Default: not shown (page still routable). */
  showInNav?: boolean;
  /** Whether the nav entry is visible for this user. Default: internal users only. */
  navVisible?: (ctx: { isExternal: boolean; userRole: string }) => boolean;
  /** Render the page body. Should gate its own access (e.g. return null for external). */
  render: (ctx: ExtraPageContext) => ReactNode;
}

/** Private top-level pages contributed by a downstream fork. Empty upstream. */
export const EXTRA_PAGES: ExtraPage[] = [];

export function getExtraPage(key: string): ExtraPage | undefined {
  return EXTRA_PAGES.find((p) => p.key === key);
}

export function extraPageKeys(): string[] {
  return EXTRA_PAGES.map((p) => p.key);
}

/** Main-nav items for fork pages that opt into the nav (used by both sidebars). */
export function extraNavItems(ctx: { isExternal: boolean; userRole: string }): ExtraPageNavItem[] {
  return EXTRA_PAGES.filter((p) => p.showInNav && p.navIcon && p.navLabel).map((p) => ({
    key: p.key,
    label: p.navLabel!,
    icon: p.navIcon!,
    visible: p.navVisible ? p.navVisible(ctx) : !ctx.isExternal,
  }));
}
