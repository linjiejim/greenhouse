/**
 * The hub's places behind a sidebar (src/shell/sidebar-content.tsx): 首页 · 知识库 · 云盘 · 项目, each
 * with its own native stack; search is a page of home's stack and 「我」 opens from the sidebar's
 * foot. There is no tab bar.
 *
 * Phone (and a compact iPad window): a drawer that slides out from the leading edge — an edge
 * swipe on a place's first page (deeper, that swipe is the system back gesture) or the bar button
 * (src/ui/sidebar.tsx). Choosing a place swaps it in and closes the drawer. iPad at regular width:
 * the sidebar stays on screen beside the place, a split view (src/shell/layout-rule.ts).
 */

import React from 'react';
import { useWindowDimensions } from 'react-native';
import { Drawer } from 'expo-router/drawer';
import { SidebarContent } from '../../src/shell/sidebar-content';
import { drawerSwipes, sidebarWidth } from '../../src/shell/layout-rule';
import { useTheme } from '../../src/theme';
import { usePersistentSidebar } from '../../src/ui/sidebar';

export const unstable_settings = { initialRouteName: '(home)' };

interface RouteWithState {
  state?: { index?: number };
}

export default function DrawerLayout() {
  const { colors: c, hex } = useTheme();
  const persistent = usePersistentSidebar();
  const { width } = useWindowDimensions();
  return (
    <Drawer
      backBehavior="firstRoute"
      drawerContent={(props) => <SidebarContent {...props} />}
      screenOptions={({ route }) => ({
        headerShown: false,
        drawerType: persistent ? 'permanent' : 'slide',
        drawerPosition: 'left',
        swipeEnabled: drawerSwipes(persistent, (route as RouteWithState).state?.index ?? 0),
        swipeEdgeWidth: 32,
        overlayColor: hex.scrim,
        keyboardDismissMode: 'on-drag',
        drawerStyle: {
          width: sidebarWidth({ width, persistent }),
          backgroundColor: c.groupedBackground,
          ...(persistent ? { borderRightWidth: 0.5, borderRightColor: hex.separator } : null),
        },
        sceneStyle: { backgroundColor: c.background },
      })}
    >
      <Drawer.Screen name="(home)" />
      <Drawer.Screen name="knowledge" />
      <Drawer.Screen name="drive" />
      <Drawer.Screen name="projects" />
    </Drawer>
  );
}
