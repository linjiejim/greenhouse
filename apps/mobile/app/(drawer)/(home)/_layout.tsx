/**
 * Home's stack: home, search, and the conversation page (`/chat`). A conversation opens here
 * from anywhere (the sidebar swaps home in first), so on an iPad the sidebar stays beside it, and
 * its back gesture returns to home.
 */

import React from 'react';
import { Stack } from 'expo-router';
import { useTheme } from '../../../src/theme';
import { detailScreen, pageScreen, stackDefaults } from '../../../src/ui/nav';

export default function HomeLayout() {
  const { colors: c, hex, isDark } = useTheme();
  return (
    <Stack screenOptions={{ ...stackDefaults(c, hex, isDark), ...pageScreen(c, { grouped: true, compact: true }) }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="search" />
      <Stack.Screen name="chat" options={detailScreen(c)} />
    </Stack>
  );
}
