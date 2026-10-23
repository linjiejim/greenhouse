/**
 * Drawer group — home lives *inside* the left drawer, so moving between the hub's places is one
 * gesture: swipe right from anywhere (or tap ☰) to slide home aside and reveal the places
 * (src/shell/drawer-content.tsx: Home, Knowledge, Files, Projects, Tables, then the station and
 * Settings); tap one, or the dimmed edge, to slide back. Options in `drawerScreenOptions`
 * (src/ui/drawer.tsx).
 *
 * The single drawer screen is `(main)`, a native stack that gives home a real navigation bar
 * (large title + toolbar buttons). Every other place, the notification page and settings are
 * presented by the *root* stack above the drawer, with native back-swipe.
 */

import React, { useMemo } from 'react';
import { Drawer } from 'expo-router/drawer';
import { useTheme } from '../../src/theme';
import { drawerScreenOptions } from '../../src/ui/drawer';
import { DrawerContent } from '../../src/shell/drawer-content';

export default function DrawerLayout() {
  const { colors: c, hex } = useTheme();
  const screenOptions = useMemo(() => drawerScreenOptions(c, hex), [c, hex]);
  return (
    <Drawer screenOptions={screenOptions} drawerContent={(props) => <DrawerContent {...props} />}>
      <Drawer.Screen name="(main)" />
    </Drawer>
  );
}
