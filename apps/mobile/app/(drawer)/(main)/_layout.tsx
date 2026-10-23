/**
 * Home's native stack — exists so home gets a real UINavigationBar (collapsing large title,
 * Liquid Glass toolbar buttons, soft scroll-edge effect) while living inside the drawer. One
 * screen; every other place is pushed by the root stack above the drawer.
 */

import React from 'react';
import { Stack } from 'expo-router';
import { useTheme } from '../../../src/theme';
import { pageScreen, stackDefaults } from '../../../src/ui/nav';

export default function MainLayout() {
  const { colors: c, hex, isDark } = useTheme();
  return (
    <Stack screenOptions={{ ...stackDefaults(c, hex, isDark), ...pageScreen(c, { grouped: true }) }}>
      <Stack.Screen name="index" options={{ gestureEnabled: false }} />
    </Stack>
  );
}
