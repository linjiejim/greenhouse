import React from 'react';
import { Pressable, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useWideShell } from '../shell/wide-shell.web';
import { Icon } from './core';
import { useT } from '../lib/i18n';
import type { NativeStackNavigationOptions } from 'expo-router/build/react-navigation/native-stack';
import type { HexPalette, ThemeColors } from '../theme';
export function stackDefaults(c: ThemeColors, hex: HexPalette, _isDark: boolean): NativeStackNavigationOptions {
  return {
    headerTintColor: hex.secondaryLabel,
    headerTitleStyle: { color: hex.label, fontFamily: 'Nunito', fontSize: 15 },
    headerStyle: { backgroundColor: hex.background, height: 52 } as NativeStackNavigationOptions['headerStyle'],
    headerShadowVisible: false,
    headerBackButtonDisplayMode: 'minimal',
    headerLeft: () => <HeaderNavigation />,
    contentStyle: { backgroundColor: c.background },
    animation: 'none',
  };
}
export function pageScreen(
  c: ThemeColors,
  _opts: { grouped?: boolean; compact?: boolean } = {},
): NativeStackNavigationOptions {
  return {
    headerShown: true,
    headerTransparent: false,
    headerLargeTitleEnabled: false,
    contentStyle: { backgroundColor: c.background },
  };
}
export const detailScreen = pageScreen;
export function sheetScreen(
  _detents: number[] | 'fitToContents' = [0.5, 1],
  _opts: { header?: boolean; initial?: number } = {},
): NativeStackNavigationOptions {
  return {
    presentation: 'transparentModal',
    animation: 'none',
    headerShown: false,
    contentStyle: { backgroundColor: 'transparent' },
  };
}
export function modalScreen(): NativeStackNavigationOptions {
  return {
    presentation: 'transparentModal',
    animation: 'none',
    headerShown: false,
    contentStyle: { backgroundColor: 'transparent' },
  };
}

function HeaderNavigation() {
  const { width } = useWindowDimensions();
  const shell = useWideShell();
  const router = useRouter();
  const t = useT();
  if (width >= 1100) return null;
  if (width >= 760)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('client.secondary')}
        onPress={shell.toggleSecondary}
        style={{ padding: 8 }}
      >
        <Icon name="menu" size={18} />
      </Pressable>
    );
  if (!router.canGoBack()) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('client.back')}
      onPress={() => router.back()}
      style={{ padding: 12 }}
    >
      <Icon name="chevL" size={20} />
    </Pressable>
  );
}
