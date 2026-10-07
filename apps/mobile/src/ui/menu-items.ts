/**
 * The menu model shared by both platforms' `NativeMenu` (./menu.tsx — iOS
 * system menus, ./menu.android.tsx — Material dropdowns): items, sections,
 * submenus, checkmarks, destructive styling.
 */
import type { IconName } from './core';

export interface MenuItem {
  id: string;
  title: string;
  icon?: IconName;
  destructive?: boolean;
  disabled?: boolean;
  /** Renders a checkmark (single/multi-select menus). */
  checked?: boolean;
  /** Nested items: a submenu, or an inline section when `inline` is set. */
  children?: MenuItem[];
  /** Render `children` inline as a titled section instead of a submenu. */
  inline?: boolean;
}

/**
 * Group items into inline sections (rendered with separators), e.g.
 * `menuSections([[copy, share], [del]])` — the idiomatic way to set the
 * destructive action apart at the bottom.
 */
export function menuSections(groups: MenuItem[][]): MenuItem[] {
  return groups
    .filter((g) => g.length > 0)
    .map((g, i) => ({ id: `__section-${i}`, title: '', inline: true, children: g }));
}
