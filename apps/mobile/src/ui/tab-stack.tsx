/** A place's own native stack (app/(drawer)/<place>/_layout.tsx): compact inline titles, pages pushed inside the place. */

import React from 'react';
import { Stack } from 'expo-router';
import { useTheme } from '../theme';
import { pageScreen, stackDefaults } from './nav';

export function TabStack() {
  const { colors: c, hex, isDark } = useTheme();
  return (
    <Stack screenOptions={{ ...stackDefaults(c, hex, isDark), ...pageScreen(c, { grouped: true, compact: true }) }} />
  );
}
