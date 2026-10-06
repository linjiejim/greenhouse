/**
 * The conversation's native stack — exists so the conversation gets a real
 * UINavigationBar (inline title, Liquid Glass toolbar buttons, soft scroll-edge
 * effect) while living inside the drawer. One screen: opening another
 * conversation from the drawer (or 新对话) *replaces* it — the drawer is the
 * navigation, there is no back stack — with a quick cross-fade instead of a
 * push slide, so switching conversations reads as swapping the page in place.
 */

import React from 'react';
import { Stack } from 'expo-router';
import { useTheme } from '../../../src/theme';
import { detailScreen, stackDefaults } from '../../../src/ui/nav';

export default function MainLayout() {
  const { colors: c, hex } = useTheme();
  return (
    <Stack screenOptions={{ ...stackDefaults(c, hex), ...detailScreen(c) }}>
      <Stack.Screen name="index" options={{ animation: 'fade', animationDuration: 200, gestureEnabled: false }} />
    </Stack>
  );
}
