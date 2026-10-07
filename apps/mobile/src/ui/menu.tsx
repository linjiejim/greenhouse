/**
 * Native menus — the only way the app shows a list of actions.
 *
 * iOS renders these as system UIMenus (SwiftUI `Menu` for tap triggers,
 * `ContextMenu` with the lifted preview for long-press), so they get Liquid
 * Glass, haptics, submenus, checkmarks and destructive styling for free.
 * There is no JS action sheet in the app any more: anything that used to be a
 * "pick one of these actions" popup is a `NativeMenu` (or a
 * `Stack.Toolbar.Menu` when it lives in the navigation bar).
 *
 *  - `NativeMenu trigger="tap"` — a button that opens a menu (overflow `…`,
 *    the composer's `+`, the agent-profile chip).
 *  - `NativeMenu trigger="longPress"` — a context menu on any view (message
 *    bubbles, list rows, task cards). Pair it with a normal `onPress` on the
 *    child for the primary action.
 *
 * Item ids come back through `onSelect(id)`. Android: ./menu.android.tsx
 * (Material dropdowns, same API).
 */

import React, { useMemo, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { MenuView, type MenuAction } from '@expo/ui/community/menu';
import { sfSymbol } from './core';
import type { MenuItem } from './menu-items';

export { menuSections, type MenuItem } from './menu-items';

function toAction(item: MenuItem): MenuAction {
  return {
    id: item.id,
    title: item.title,
    image: item.icon ? sfSymbol(item.icon) : undefined,
    state: item.checked ? 'on' : undefined,
    attributes:
      item.destructive || item.disabled ? { destructive: item.destructive, disabled: item.disabled } : undefined,
    subactions: item.children?.map(toAction),
    displayInline: item.inline,
  };
}

export function NativeMenu({
  items,
  onSelect,
  title,
  trigger = 'tap',
  fill,
  width: fixedWidth,
  children,
  style,
  testID,
}: {
  items: MenuItem[];
  onSelect: (id: string) => void;
  /** Optional header line at the top of the menu. */
  title?: string;
  trigger?: 'tap' | 'longPress';
  /**
   * Stretch the trigger to the available width (rows, bubbles). Defaults to
   * true for long-press menus, false for tap menus (buttons keep their size).
   * The SwiftUI host otherwise sizes the trigger to its *intrinsic* width,
   * which overflows for wrapping text.
   */
  fill?: boolean;
  /**
   * Known trigger width (e.g. drawer rows, full-width bubbles). Skips the
   * measure-then-reparent pass, so the child subtree mounts once.
   */
  width?: number;
  /** The trigger view. */
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const stretch = fill ?? trigger === 'longPress';
  const [width, setWidth] = useState<number | null>(null);
  const actions = useMemo(() => items.map(toAction), [items]);
  const menu = (inner: React.ReactNode) => (
    <MenuView
      title={title}
      actions={actions}
      onPressAction={(e) => onSelect(e.nativeEvent.event)}
      shouldOpenOnLongPress={trigger === 'longPress'}
      style={stretch ? undefined : style}
      testID={testID}
    >
      {inner}
    </MenuView>
  );
  if (!stretch) return menu(children);
  if (fixedWidth != null) return <View style={style}>{menu(<View style={{ width: fixedWidth }}>{children}</View>)}</View>;
  // Measure the slot with the children laid out bare first, then pin the
  // trigger to that width so text wraps inside the menu host — rounded *up*:
  // pinned a fraction of a point narrower than measured, a one-line bubble
  // wraps its last character onto a second line. NOTE: this swap
  // mounts the child subtree twice (once bare, once inside the host). Keeping
  // the tree identical instead (children inside the host from the start, width
  // pinned later) was tried and is wrong: the hosted subtree is measured once
  // at its intrinsic, unconstrained size and text never re-wraps to the pinned
  // width (rows render one overflowing line) — verified on iOS 26.5.
  return (
    <View style={style} onLayout={(e) => setWidth(Math.ceil(e.nativeEvent.layout.width))}>
      {width == null ? children : menu(<View style={{ width }}>{children}</View>)}
    </View>
  );
}

/** iOS menus are system UIMenus — nothing to mount (Android: the Material menu host). */
export function MenuHost(): null {
  return null;
}
