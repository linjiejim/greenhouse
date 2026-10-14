/**
 * Drawer group — the conversation surface lives *inside* the left drawer, so the whole core loop
 * (talk ⇄ switch conversation) is one gesture: swipe right from anywhere to slide the
 * conversation aside and reveal the directory; tap a conversation (or the dimmed edge) to slide
 * back. Options in `drawerScreenOptions` (src/ui/drawer.tsx); the panel is
 * src/shell/drawer-content.tsx (the directory and the module bar).
 *
 * The drawer's pan is exposed as `drawerPanRef` (src/chat/drawer-gesture.ts) so sideways
 * scrollers in replies (tables, code, charts) can let a rightward swipe from their leading edge
 * open the drawer.
 *
 * The single drawer screen is `(main)`, a native stack that gives the conversation a real
 * navigation bar (title + glass toolbar buttons). Agents, runs, notifications and settings are
 * presented by the *root* stack above the drawer, with native back-swipe.
 */

import React, { useMemo } from 'react';
import { Drawer } from 'expo-router/drawer';
import { useTheme } from '../../src/theme';
import { drawerScreenOptions } from '../../src/ui/drawer';
import { DrawerContent } from '../../src/shell/drawer-content';
import { drawerPanRef } from '../../src/chat/drawer-gesture';

export default function DrawerLayout() {
  const { colors: c, hex } = useTheme();
  const screenOptions = useMemo(() => {
    const base = drawerScreenOptions(c, hex);
    const configure = base.configureGestureHandler;
    return {
      ...base,
      configureGestureHandler: (g: Parameters<NonNullable<typeof configure>>[0]) =>
        (configure ? configure(g) : g).withRef(drawerPanRef),
    };
  }, [c, hex]);
  return (
    <Drawer screenOptions={screenOptions} drawerContent={(props) => <DrawerContent {...props} />}>
      <Drawer.Screen name="(main)" />
    </Drawer>
  );
}
