/**
 * Native menus on Android — Material 3 dropdown menus (Jetpack Compose), with
 * the same API as ./menu.tsx (iOS system menus).
 *
 * The trigger stays a plain RN view: menus open from native gesture
 * recognisers on it (react-native-gesture-handler), which run alongside RN
 * touchables — a row's own `onPress` still opens it, and a long press cancels
 * that touch and opens the menu instead (an RN wrapper `Pressable` would never
 * see presses its child already handles).
 *
 * The dropdown itself lives in ONE place: `MenuHost`, mounted once by the
 * root layout — so no list row carries a Compose view (a Compose host inside
 * a virtualized list cell may never attach, and one per row is heavy). A
 * trigger hands the host its items and a screen point to anchor at:
 *  - `trigger="longPress"` → the finger (a reply or row can be tall),
 *  - `trigger="tap"` → under the trigger's leading edge (Material's anchor).
 * Sections are divided, submenus open in place, checked items carry a check,
 * destructive items take the error color, and `title` heads the menu.
 * `fill` / `width` exist for API parity: RN lays the trigger out natively here.
 */

import React, { useMemo, useRef, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { create } from 'zustand';
import { Box, DropdownMenu, DropdownMenuItem, HorizontalDivider, Icon, Text } from '@expo/ui/jetpack-compose';
import { size } from '@expo/ui/jetpack-compose/modifiers';
import { selectionTick, tapMedium } from './haptics';
import { M3Host, useM3 } from './m3';
import type { MenuItem } from './menu-items';
// the Android table explicitly: TypeScript resolves the bare path to the iOS one (SF names)
import { toolbarIcon } from './toolbar-icon.android';

export { menuSections, type MenuItem } from './menu-items';

interface MenuRequest {
  items: MenuItem[];
  title?: string;
  onSelect: (id: string) => void;
  /** Anchor point in window coordinates. */
  x: number;
  y: number;
}

let nextKey = 0;
const useMenu = create<{ request: (MenuRequest & { key: number }) | null }>(() => ({ request: null }));

function openMenu(request: MenuRequest): void {
  useMenu.setState({ request: { ...request, key: ++nextKey } });
}

function closeMenu(): void {
  useMenu.setState({ request: null });
}

export function NativeMenu({
  items,
  onSelect,
  title,
  trigger = 'tap',
  width,
  children,
  style,
  testID,
}: {
  items: MenuItem[];
  onSelect: (id: string) => void;
  /** Optional header line at the top of the menu. */
  title?: string;
  trigger?: 'tap' | 'longPress';
  /** iOS sizing aid (the trigger lays out natively on Android). */
  fill?: boolean;
  /** Known trigger width (applied as the wrapper's width). */
  width?: number;
  /** The trigger view. */
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const view = useRef<View>(null);
  // the latest props, read when a gesture fires (the gesture object is built once)
  const latest = useRef({ items, title, onSelect });
  latest.current = { items, title, onSelect };

  const gesture = useMemo(
    () =>
      trigger === 'longPress'
        ? Gesture.LongPress()
            .minDuration(350)
            .runOnJS(true)
            .onStart((e) => {
              tapMedium();
              openMenu({ ...latest.current, x: e.absoluteX, y: e.absoluteY });
            })
        : Gesture.Tap()
            .runOnJS(true)
            .onEnd((_e, success) => {
              if (!success) return;
              view.current?.measureInWindow((x, y, _w, h) => openMenu({ ...latest.current, x, y: y + h }));
            }),
    [trigger],
  );

  return (
    <View ref={view} style={[style, width != null ? { width } : null]} testID={testID} collapsable={false}>
      <GestureDetector gesture={gesture}>
        <View collapsable={false}>{children}</View>
      </GestureDetector>
    </View>
  );
}

/** Shows the open menu. Mount once, at the root (window coordinates). */
export function MenuHost() {
  const request = useMenu((s) => s.request);
  if (!request) return null;
  return (
    // a zero-size anchor at the menu's point; the dropdown opens in its own popup window
    <M3Host key={request.key} matchContents style={{ position: 'absolute', left: request.x, top: request.y }}>
      <DropdownMenu expanded onDismissRequest={closeMenu}>
        <DropdownMenu.Trigger>
          <Box modifiers={[size(1, 1)]} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Items>
          <MenuItems
            items={request.items}
            title={request.title}
            onPick={(id) => {
              closeMenu();
              request.onSelect(id);
            }}
          />
        </DropdownMenu.Items>
      </DropdownMenu>
    </M3Host>
  );
}

/** Consecutive plain items form a group; each inline section is its own group. */
function groups(items: MenuItem[]): MenuItem[][] {
  const out: MenuItem[][] = [];
  let loose: MenuItem[] = [];
  for (const item of items) {
    if (item.inline && item.children) {
      if (loose.length) out.push(loose);
      loose = [];
      out.push(item.children);
    } else loose.push(item);
  }
  if (loose.length) out.push(loose);
  return out.filter((g) => g.length);
}

function MenuItems({ items, title, onPick }: { items: MenuItem[]; title?: string; onPick: (id: string) => void }) {
  const m = useM3();
  return (
    <>
      {title ? (
        <DropdownMenuItem enabled={false} elementColors={{ disabledTextColor: m.onSurfaceVariant }}>
          <DropdownMenuItem.Text>
            <Text style={{ typography: 'labelMedium' }}>{title}</Text>
          </DropdownMenuItem.Text>
        </DropdownMenuItem>
      ) : null}
      {groups(items).map((group, g) => (
        <React.Fragment key={g}>
          {g > 0 || title ? <HorizontalDivider /> : null}
          {group.map((item) => (
            <Item key={item.id} item={item} onPick={onPick} />
          ))}
        </React.Fragment>
      ))}
    </>
  );
}

function Item({ item, onPick }: { item: MenuItem; onPick: (id: string) => void }) {
  const m = useM3();
  const [open, setOpen] = useState(false);
  const colors = item.destructive ? { textColor: m.error, leadingIconColor: m.error } : undefined;
  const leading = item.icon ? (
    <DropdownMenuItem.LeadingIcon>
      <Icon source={toolbarIcon(item.icon)} size={24} />
    </DropdownMenuItem.LeadingIcon>
  ) : null;

  if (item.children?.length) {
    // a submenu opens next to its item
    return (
      <DropdownMenu expanded={open} onDismissRequest={() => setOpen(false)}>
        <DropdownMenu.Trigger>
          <DropdownMenuItem enabled={!item.disabled} elementColors={colors} onClick={() => setOpen(true)}>
            <DropdownMenuItem.Text>
              <Text>{item.title}</Text>
            </DropdownMenuItem.Text>
            {leading}
            <DropdownMenuItem.TrailingIcon>
              <Icon source={toolbarIcon('chevR')} size={20} />
            </DropdownMenuItem.TrailingIcon>
          </DropdownMenuItem>
        </DropdownMenu.Trigger>
        <DropdownMenu.Items>
          <MenuItems
            items={item.children}
            onPick={(id) => {
              setOpen(false);
              onPick(id);
            }}
          />
        </DropdownMenu.Items>
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenuItem
      enabled={!item.disabled}
      elementColors={colors}
      onClick={() => {
        if (item.checked !== undefined) selectionTick();
        onPick(item.id);
      }}
    >
      <DropdownMenuItem.Text>
        <Text>{item.title}</Text>
      </DropdownMenuItem.Text>
      {leading}
      {item.checked ? (
        <DropdownMenuItem.TrailingIcon>
          <Icon source={toolbarIcon('check')} size={20} tint={m.primary} />
        </DropdownMenuItem.TrailingIcon>
      ) : null}
    </DropdownMenuItem>
  );
}
