/**
 * Native navigation presets — every screen's chrome comes from the native
 * stack (UINavigationController / UISheetPresentationController), never from a
 * hand-drawn header. Spread one of these into `<Stack.Screen options>`:
 *
 *  - `pageScreen()`   — a pushed page with a collapsing **large title** (lists,
 *    hubs: 知识库, 项目). Content scrolls under the glass bar with the iOS 26
 *    soft scroll-edge effect.
 *  - `detailScreen()` — a pushed page with an inline (small) title (documents,
 *    detail views, the conversation).
 *  - `sheetScreen(detents)` — a **form sheet** (detail peeks, pickers, short
 *    forms). Detents are fractions of the screen height; `[0.5, 1]` gives the
 *    medium/large pair. Liquid Glass background on iOS 26 at partial detents.
 *    Android: a full-screen dialog (its bottom sheets can't show a header).
 *  - `modalScreen()`  — a full page sheet for longer flows with their own
 *    stack (Settings, the knowledge editor).
 *
 * Header buttons are declared from the screen itself with `Stack.Toolbar`
 * (`toolbarIcon(name)` → glass buttons on iOS 26, Compose icon buttons on
 * Android) and titles with `Stack.Screen options={{ title }}`. Back buttons
 * are system: never draw one.
 *
 * Android: the same presets give a Material top app bar — opaque (`background`,
 * so content starts below it: offset content with `useHeaderInset()`, never
 * the raw header height), left-aligned title, no large title.
 */

import { Platform } from 'react-native';
import type { NativeStackNavigationOptions } from 'expo-router/build/react-navigation/native-stack';
import type { HexPalette, ThemeColors } from '../theme';

const ANDROID = Platform.OS === 'android';

/** Android's opaque top app bar in the page's own background (no seam, no shadow). */
function androidBar(background: ThemeColors[keyof ThemeColors]): NativeStackNavigationOptions {
  return { headerTransparent: false, headerStyle: { backgroundColor: background as string } };
}

/** Shared defaults for every native stack in the app. */
export function stackDefaults(c: ThemeColors, hex: HexPalette): NativeStackNavigationOptions {
  return {
    // navigation options take color strings — use the hex mirror. Android's
    // top app bar icons are onSurface (Material), iOS bar buttons the tint.
    headerTintColor: ANDROID ? hex.label : hex.accent,
    // titles are content, not controls — label color, never the tint
    headerTitleStyle: { color: hex.label },
    headerLargeTitleStyle: { color: hex.label },
    headerBackButtonDisplayMode: 'minimal',
    headerShadowVisible: false,
    // Android's top app bar takes the page surface (pages override it for grouped backgrounds)
    ...(ANDROID ? { headerStyle: { backgroundColor: hex.background } } : null),
    headerLargeTitleShadowVisible: false,
    // iOS 26: the full-width interactive pop gesture (swipe back from anywhere).
    fullScreenGestureEnabled: true,
    contentStyle: { backgroundColor: c.background },
  };
}

export function pageScreen(c: ThemeColors, opts: { grouped?: boolean } = {}): NativeStackNavigationOptions {
  const background = opts.grouped ? c.groupedBackground : c.background;
  return {
    headerShown: true,
    headerLargeTitleEnabled: true,
    headerTransparent: true,
    scrollEdgeEffects: { top: 'soft' },
    contentStyle: { backgroundColor: background },
    ...(ANDROID ? androidBar(background) : null),
  };
}

export function detailScreen(c: ThemeColors, opts: { grouped?: boolean } = {}): NativeStackNavigationOptions {
  const background = opts.grouped ? c.groupedBackground : c.background;
  return {
    headerShown: true,
    headerLargeTitleEnabled: false,
    headerTransparent: true,
    scrollEdgeEffects: { top: 'soft' },
    contentStyle: { backgroundColor: background },
    ...(ANDROID ? androidBar(background) : null),
  };
}

export function sheetScreen(
  detents: number[] | 'fitToContents' = [0.5, 1],
  opts: { header?: boolean; initial?: number } = {},
): NativeStackNavigationOptions {
  if (ANDROID) {
    // Android form sheets (Material BottomSheetBehavior) render no header, so
    // a sheet would lose its title and ✕ / ✓ actions. Present it as Material's
    // full-screen dialog instead: slides up, top app bar with the screen's
    // title and toolbar (its ✕ replaces ←), system back closes it.
    return { presentation: 'modal', animation: 'slide_from_bottom', headerShown: true, headerTransparent: false };
  }
  return {
    presentation: 'formSheet',
    sheetAllowedDetents: detents,
    sheetInitialDetentIndex: opts.initial ?? 0,
    sheetGrabberVisible: true,
    sheetExpandsWhenScrolledToEdge: true,
    headerShown: opts.header ?? false,
    // transparent so iOS 26 shows the Liquid Glass sheet material
    contentStyle: { backgroundColor: 'transparent' },
  };
}

export function modalScreen(): NativeStackNavigationOptions {
  return {
    presentation: 'modal',
    headerShown: false,
  };
}
