/**
 * The hub's places behind a sidebar (src/shell/sidebar-content.tsx): 首页 · 知识库 · 云盘 · 项目, each
 * with its own native stack; search is a page of home's stack and 「我」 opens from the sidebar's
 * foot. There is no tab bar.
 *
 * Phone (and a compact iPad window): the sidebar lies under the place, a layer below it; an edge
 * swipe on a place's first page (deeper, that swipe is the system back gesture) or the bar button
 * (src/ui/sidebar.tsx) slides the place aside to show it (iOS: drawerType 'back', the scene's
 * leading edge drawn by a shadow in light mode and a hairline in dark, where nothing is deeper than
 * black). Choosing a place swaps it in and closes the drawer. iPad at regular width: the sidebar
 * stays on screen beside the place, a split view (src/shell/layout-rule.ts).
 */

import React from 'react';
import { Platform, StyleSheet, useWindowDimensions } from 'react-native';
import { Drawer } from 'expo-router/drawer';
import { SidebarContent } from '../../src/shell/sidebar-content';
import { drawerSwipes, sidebarWidth } from '../../src/shell/layout-rule';
import { useTheme } from '../../src/theme';
import { usePersistentSidebar } from '../../src/ui/sidebar';

export const unstable_settings = { initialRouteName: '(home)' };

export default function DrawerLayout() {
  const { colors: c, hex, isDark } = useTheme();
  const persistent = usePersistentSidebar();
  const { width } = useWindowDimensions();
  return (
    <Drawer
      backBehavior="firstRoute"
      drawerContent={(props) => <SidebarContent {...props} />}
      screenOptions={{
        headerShown: false,
        drawerType: persistent ? 'permanent' : Platform.OS === 'ios' ? 'back' : 'slide',
        drawerPosition: 'left',
        // a place's stack turns this off on its deeper pages (src/ui/place-swipe.ts)
        swipeEnabled: drawerSwipes(persistent, 0),
        swipeEdgeWidth: 32,
        // iOS: the place slides aside over the sidebar and stays lit (a scrim would make it read as the lower layer)
        overlayColor: Platform.OS === 'ios' ? 'transparent' : hex.scrim,
        keyboardDismissMode: 'on-drag',
        drawerStyle: {
          width: sidebarWidth({ width, persistent }),
          backgroundColor: c.sidebarBackground,
          ...(persistent ? { borderRightWidth: 0.5, borderRightColor: hex.separator } : null),
        },
        sceneStyle: [
          { backgroundColor: c.background },
          // the place's leading edge over the sidebar it slides off (offscreen while closed)
          !persistent && Platform.OS === 'ios'
            ? isDark
              ? { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: hex.opaqueSeparator }
              : { shadowColor: hex.label, shadowOffset: { width: -2, height: 0 }, shadowOpacity: 0.14, shadowRadius: 10 }
            : null,
        ],
      }}
    >
      <Drawer.Screen name="(home)" />
      <Drawer.Screen name="knowledge" />
      <Drawer.Screen name="drive" />
      <Drawer.Screen name="projects" />
    </Drawer>
  );
}
