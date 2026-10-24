/** A tab's own native stack (app/(tabs)/<tab>/_layout.tsx): large titles, pages pushed inside the tab. */

import React from 'react';
import { Stack } from 'expo-router';
import { useTheme } from '../theme';
import { pageScreen, stackDefaults } from './nav';

export function TabStack() {
  const { colors: c, hex, isDark } = useTheme();
  return <Stack screenOptions={{ ...stackDefaults(c, hex, isDark), ...pageScreen(c, { grouped: true }) }} />;
}
