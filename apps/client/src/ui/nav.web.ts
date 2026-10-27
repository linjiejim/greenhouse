/** Web headers participate in layout; transparent native bars would overlap content. */
import type { NativeStackNavigationOptions } from 'expo-router/build/react-navigation/native-stack';
import type { ThemeColors, HexPalette } from '../theme';
export function stackDefaults(c: ThemeColors, hex: HexPalette, _isDark: boolean): NativeStackNavigationOptions {
  return {
    headerTintColor: hex.accent,
    headerTitleStyle: { color: hex.label, fontFamily: 'Nunito' },
    headerTitleAlign: 'left',
    headerShadowVisible: false,
    headerTransparent: false,
    headerStyle: { backgroundColor: hex.background, height: 52 } as NativeStackNavigationOptions['headerStyle'],
    contentStyle: { backgroundColor: c.background },
    animation: 'none',
  };
}
export function pageScreen(
  c: ThemeColors,
  _opts: { grouped?: boolean; compact?: boolean } = {},
): NativeStackNavigationOptions {
  return { headerShown: true, headerTransparent: false, contentStyle: { backgroundColor: c.background } };
}
export const detailScreen = pageScreen;
export function sheetScreen(
  _detents?: number[] | 'fitToContents',
  _opts?: { header?: boolean; initial?: number },
): NativeStackNavigationOptions {
  return {
    presentation: 'transparentModal',
    headerShown: false,
    animation: 'none',
    contentStyle: { backgroundColor: 'transparent' },
  };
}
export const modalScreen = sheetScreen;
