/**
 * Settings — a page-sheet modal with its own native stack: the large-title
 * root (index.tsx, a SwiftUI Form) and its pushed sub-pages (工作站, 通知, 标签,
 * 我的 Bot, 连接器), each with a collapsing large title and the system back button —
 * except a Bot's profile page (`bot`), whose hero carries the name (inline
 * title). A deep link straight to a sub-page (`greenhouse://settings/tags`)
 * still gets the root underneath (`initialRouteName`), so it has a back button.
 */

import React from 'react';
import { Stack } from 'expo-router';
import { useTheme } from '../../src/theme';
import { detailScreen, pageScreen, stackDefaults } from '../../src/ui/nav';

export const unstable_settings = { initialRouteName: 'index' };

export default function SettingsLayout() {
  const { colors: c, hex } = useTheme();
  return (
    <Stack screenOptions={{ ...stackDefaults(c, hex), ...pageScreen(c, { grouped: true }) }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="stations" />
      <Stack.Screen name="tags" />
      <Stack.Screen name="bots" />
      <Stack.Screen name="connectors" />
      <Stack.Screen name="notifications" />
      <Stack.Screen name="bot" options={detailScreen(c, { grouped: true })} />
    </Stack>
  );
}
