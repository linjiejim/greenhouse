/**
 * The sidebar's shape. React-free (./layout-rule.test.ts).
 *
 * On a phone, and an iPad window at compact width (Slide Over, a narrow Split View side), the
 * sidebar is a drawer over home: an edge swipe or the bar button slides it out. An iPad window at
 * regular width keeps it on screen beside the content, a split view.
 */

/** UIKit's regular width starts here on iPad (the smallest full-screen iPad, mini, is 744 pt). */
export const REGULAR_MIN_WIDTH = 740;

/** Whether the sidebar stays on screen. */
export function persistentSidebar(window: { isPad: boolean; width: number }): boolean {
  return window.isPad && window.width >= REGULAR_MIN_WIDTH;
}

/** The sidebar's width: a drawer leaves some of home in view; a persistent one is a column. */
export function sidebarWidth(window: { width: number; persistent: boolean }): number {
  if (window.persistent) return Math.round(Math.min(340, Math.max(280, window.width * 0.26)));
  return Math.round(Math.min(320, window.width * 0.82));
}

/** A place's route as the drawer sees it: its nested stack state may be missing or partial. */
export interface PlaceRoute {
  state?: { index?: number; routes?: readonly unknown[] };
  params?: object;
}

/**
 * How deep a place's stack is (0 on its first page). The nested state can be partial: a page
 * pushed by path may arrive without `index` (the last route is the focused one, as React
 * Navigation rehydrates it), or before the stack has any state at all (then `params.screen`
 * names the page being opened; every place's first page is `index`).
 */
export function placeDepth(route: PlaceRoute): number {
  const routes = route.state?.routes;
  if (routes?.length) return route.state?.index ?? routes.length - 1;
  const screen = (route.params as { screen?: unknown } | undefined)?.screen;
  return typeof screen === 'string' && screen !== 'index' ? 1 : 0;
}

/**
 * The edge swipe opens the drawer only on a place's first page: deeper (search, a conversation,
 * a folder), the same swipe is the system back gesture.
 */
export function drawerSwipes(persistent: boolean, route: PlaceRoute): boolean {
  return !persistent && placeDepth(route) === 0;
}
