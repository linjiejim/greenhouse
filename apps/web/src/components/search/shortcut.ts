/**
 * The global-search shortcut, in one place so the tooltip and the key handler
 * can never disagree about what to press.
 *
 * ⌘P rather than the more usual ⌘K, which this app already spends on the
 * Assistant overlay. ⌘P costs the browser's print dialog inside the app — the
 * standard trade every palette-bearing editor makes, and printing a workbench
 * page is not a thing people do here.
 */

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const SEARCH_SHORTCUT_LABEL = isMac ? '⌘P' : 'Ctrl+P';

/** True when this keydown is the search shortcut. */
export function isSearchShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p';
}
