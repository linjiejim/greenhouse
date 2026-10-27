/**
 * 「我」 — a page sheet with its own native stack, opened from the avatar on home: the root
 * (index.tsx: account, station, text size, my agents, settings) and its pushed pages (工作站,
 * 通知, 我的 Agent, 连接, 发送反馈). A deep link straight to a sub-page still gets the root underneath
 * (`initialRouteName`), so it has a back button.
 */

import React from 'react';
import { Stack } from 'expo-router';
import { sheetEdgeLayout } from '../../src/ui/sheet-edge';
import { useTheme } from '../../src/theme';
import { pageScreen, stackDefaults } from '../../src/ui/nav';

export const unstable_settings = { initialRouteName: 'index' };

export default function MeLayout() {
  const { colors: c, hex, isDark } = useTheme();
  return (
    <Stack
      screenLayout={sheetEdgeLayout}
      screenOptions={{ ...stackDefaults(c, hex, isDark), ...pageScreen(c, { grouped: true }) }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="stations" />
      <Stack.Screen name="notifications" />
      <Stack.Screen name="agents" />
      <Stack.Screen name="connectors" />
      <Stack.Screen name="feedback" />
    </Stack>
  );
}
