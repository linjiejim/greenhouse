/**
 * The sidebar's controls (rules in src/shell/layout-rule.ts; the panel is src/shell/sidebar-content.tsx,
 * the navigator app/(drawer)/_layout.tsx).
 *
 *  - `usePersistentSidebar()`: an iPad window at regular width keeps the sidebar on screen.
 *  - `SidebarToolbar`: the bar button that slides the drawer out, at the leading edge of a
 *    section's first page; absent where the sidebar stays on screen and on pushed pages (their
 *    leading edge is the back button).
 */

import React from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { Stack, useNavigation } from 'expo-router';
import { DrawerActions, useNavigationState } from 'expo-router/react-navigation';
import { useT } from '../lib/i18n';
import { persistentSidebar } from '../shell/layout-rule';
import { toolbarIcon } from './toolbar-icon';

const IS_PAD = Platform.OS === 'ios' && Platform.isPad;

export function usePersistentSidebar(): boolean {
  const { width } = useWindowDimensions();
  return persistentSidebar({ isPad: IS_PAD, width });
}

export function SidebarToolbar() {
  const t = useT();
  const navigation = useNavigation();
  const depth = useNavigationState((state) => state?.index ?? 0);
  const persistent = usePersistentSidebar();
  if (persistent || depth > 0) return null;
  return (
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.Button
        icon={toolbarIcon('menu')}
        accessibilityLabel={t('nav.sidebar')}
        onPress={() => navigation.dispatch(DrawerActions.openDrawer())}
      />
    </Stack.Toolbar>
  );
}
