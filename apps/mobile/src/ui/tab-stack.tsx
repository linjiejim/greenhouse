/** A place's own native stack (app/(drawer)/<place>/_layout.tsx): compact inline titles, pages pushed inside the place. */

import React from 'react';
import { Stack } from 'expo-router';
import { useTheme } from '../theme';
import { pageScreen, stackDefaults } from './nav';
import { usePlaceSwipe } from './place-swipe';

export function TabStack() {
  const { colors: c, hex, isDark } = useTheme();
  const placeSwipe = usePlaceSwipe();
  return (
    <Stack screenListeners={placeSwipe} screenOptions={{ ...stackDefaults(c, hex, isDark), ...pageScreen(c, { grouped: true, compact: true }) }} />
  );
}
