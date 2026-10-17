/**
 * Who may take focus when a page finishes opening. Pages load lazily and their data arrives
 * later still, so by then the member may already be in the directory's search, on a row or in a
 * menu; a page that grabs focus on mount would pull them out mid-keystroke.
 */

import { focusAtNavigation } from './router';

/**
 * Focus is still where the navigation left it: nowhere, on the row or button that navigated, or
 * inside the same dialog as `element` (a drawer that opened around it). Only then may `element`
 * take it.
 */
export function focusUnclaimed(element: Element): boolean {
  const active = document.activeElement;
  if (!active || active === document.body || active === focusAtNavigation()) return true;
  const dialog = element.closest('[role="dialog"]');
  return !!dialog && dialog.contains(active);
}
