/**
 * Drawer group — Home sits behind the native left drawer. The navigator
 * (react-native-drawer-layout via expo-router's `Drawer`) provides the slide,
 * scrim, and iOS-style left edge-swipe to open; the panel body is
 * HomeDrawerContent. Chat / knowledge / settings are pushed on the *root* stack
 * above this group, so the drawer only exists on Home.
 */

import React from 'react';
import { Drawer } from 'expo-router/drawer';
import { useTheme } from '../../src/theme';
import { drawerScreenOptions } from '../../src/ui';
import { HomeDrawerContent } from '../../src/chat/home-drawer';

export default function DrawerLayout() {
  const { colors: c } = useTheme();
  return (
    <Drawer screenOptions={drawerScreenOptions(c)} drawerContent={(props) => <HomeDrawerContent {...props} />}>
      <Drawer.Screen name="index" />
    </Drawer>
  );
}
