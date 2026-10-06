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
 *  - `modalScreen()`  — a full page sheet for longer flows with their own
 *    stack (Settings, the knowledge editor).
 *
 * Header buttons are declared from the screen itself with `Stack.Toolbar`
 * (SF Symbol icons → glass buttons on iOS 26) and titles with
 * `Stack.Screen options={{ title }}`. Back buttons are system: never draw one.
 */

import type { NativeStackNavigationOptions } from 'expo-router/build/react-navigation/native-stack';
import type { HexPalette, ThemeColors } from '../theme';

/** Shared defaults for every native stack in the app. */
export function stackDefaults(c: ThemeColors, hex: HexPalette): NativeStackNavigationOptions {
  return {
    // navigation options take color strings — use the hex mirror
    headerTintColor: hex.accent,
    // titles are content, not controls — label color, never the tint
    headerTitleStyle: { color: hex.label },
    headerLargeTitleStyle: { color: hex.label },
    headerBackButtonDisplayMode: 'minimal',
    headerShadowVisible: false,
    headerLargeTitleShadowVisible: false,
    // iOS 26: the full-width interactive pop gesture (swipe back from anywhere).
    fullScreenGestureEnabled: true,
    contentStyle: { backgroundColor: c.background },
  };
}

export function pageScreen(c: ThemeColors, opts: { grouped?: boolean } = {}): NativeStackNavigationOptions {
  return {
    headerShown: true,
    headerLargeTitleEnabled: true,
    headerTransparent: true,
    scrollEdgeEffects: { top: 'soft' },
    contentStyle: { backgroundColor: opts.grouped ? c.groupedBackground : c.background },
  };
}

export function detailScreen(c: ThemeColors, opts: { grouped?: boolean } = {}): NativeStackNavigationOptions {
  return {
    headerShown: true,
    headerLargeTitleEnabled: false,
    headerTransparent: true,
    scrollEdgeEffects: { top: 'soft' },
    contentStyle: { backgroundColor: opts.grouped ? c.groupedBackground : c.background },
  };
}

export function sheetScreen(
  detents: number[] | 'fitToContents' = [0.5, 1],
  opts: { header?: boolean; initial?: number } = {},
): NativeStackNavigationOptions {
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
