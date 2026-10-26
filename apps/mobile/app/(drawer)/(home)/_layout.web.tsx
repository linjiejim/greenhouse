import React from 'react';
import { Stack } from 'expo-router';
import { useTheme } from '../../../src/theme';
import { detailScreen, pageScreen, stackDefaults } from '../../../src/ui/nav';
export default function HomeLayout() {
  const { colors: c, hex, isDark } = useTheme();
  return (
    <Stack screenOptions={{ ...stackDefaults(c, hex, isDark), ...pageScreen(c, { grouped: true, compact: true }) }}>
      <Stack.Screen name="index" />
      <Stack.Screen
        name="search"
        options={{
          presentation: 'transparentModal',
          headerShown: false,
          contentStyle: { backgroundColor: 'transparent' },
        }}
      />
      <Stack.Screen name="chat" options={detailScreen(c)} />
    </Stack>
  );
}
