/**
 * The icon for a navigation-bar item (`Stack.Toolbar.Button` / `Menu` /
 * `MenuAction` `icon=`) from a semantic `IconName` — the SF Symbol on iOS.
 * Android (./toolbar-icon.android.ts) needs an image source there instead:
 * SF Symbol names render nothing in its Compose toolbar.
 */
import { sfSymbol, type IconName } from './core';

export function toolbarIcon(name: IconName): ReturnType<typeof sfSymbol> {
  return sfSymbol(name);
}

/**
 * A bar's overflow menu and its actions in platform order: iOS puts `…` before
 * the actions (the primary action trails), Android puts `⋮` last (Material).
 */
export function overflowLast<T>(overflow: T, ...actions: T[]): T[] {
  return [overflow, ...actions];
}
