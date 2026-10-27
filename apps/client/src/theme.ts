/**
 * Greenhouse content colors (./theme/palette.ts, generated from the shared token module), with
 * UIKit/SwiftUI and Material owning native controls.
 * RN content selects an explicit palette with the app theme: nested dynamic
 * UIColors can resolve against different traits inside a native header or Host.
 * Dark content values mirror system surfaces; controls still use system styling.
 * `colors` are opaque ColorValues; use `hex` for SVG and alpha calculations.
 */

import { useEffect } from 'react';
import { Appearance, Platform, StyleSheet, useColorScheme, type ColorValue, type TextStyle } from 'react-native';
import { usePrefs } from './store/prefs';
import { materialPalette } from './theme-m3';
import { DEFAULT_TEXT_STEP, scaleText, TEXT_STEPS } from './theme/type-scale';

/* ------------------------------ hex mirrors ------------------------------ */

import { lightHex, darkHex, type HexPalette } from './theme/palette';
export { categoricalFor, type CategoricalPair } from './theme/palette';
export type { HexPalette } from './theme/palette';
const BRAND_LIGHT = lightHex.accent;

/* ---------------------------- Android palette ---------------------------- */

/** Brand seed of the Material 3 palette on Android (src/theme-m3.android.ts). */
export const SEED = BRAND_LIGHT;

const LIGHT = Platform.OS === 'android' ? materialPalette(lightHex, 'light', SEED) : lightHex;
const DARK = Platform.OS === 'android' ? materialPalette(darkHex, 'dark', SEED) : darkHex;

export type ThemeColors = { [K in keyof HexPalette]: ColorValue };

/** Stable objects per appearance keep RN content and native Host colors in sync. */
export function useTheme(): { colors: ThemeColors; hex: HexPalette; isDark: boolean; textScale: number } {
  const scheme = useColorScheme();
  const pref = usePrefs((s) => s.theme);
  // subscribing re-renders every themed component when the in-app text size changes, so its
  // makeStyles sheet is rebuilt at the new size (see `typo` below)
  const textScale = TEXT_STEPS[usePrefs((s) => s.textStep)];
  const isDark = pref === 'dark' || (pref === 'system' && scheme === 'dark');
  const hex = isDark ? DARK : LIGHT;
  return { colors: hex, hex, isDark, textScale };
}

/**
 * Apply the in-app theme preference to the whole UI (UIKit trait override), so
 * native headers, sheets, menus and SwiftUI follow it. Call
 * once from the root layout.
 */
export function useApplyAppearance(): void {
  const pref = usePrefs((s) => s.theme);
  useEffect(() => {
    Appearance.setColorScheme(pref === 'system' ? 'unspecified' : pref);
  }, [pref]);
}

/**
 * Build a themed StyleSheet factory. Define once at module scope:
 *   const useStyles = makeStyles((c) => ({ root: { backgroundColor: c.background } }));
 * then inside the component:
 *   const { colors: c } = useTheme();
 *   const styles = useStyles(c);
 * Sheets are created once per palette object and cached.
 */
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(fn: (c: ThemeColors) => T): (c: ThemeColors) => T {
  const cache = new Map<string, T>();
  return (c: ThemeColors): T => {
    // one sheet per palette and text size: `typo` reads the current size while `fn` runs
    const key = `${c === DARK ? 'dark' : 'light'}:${currentScale}`;
    let s = cache.get(key);
    if (!s) {
      s = StyleSheet.create(fn(c));
      cache.set(key, s);
    }
    return s;
  };
}

/* ------------------------------ typography ------------------------------ */

/**
 * iOS text styles (HIG, default "Large" content size; Android: the Material
 * type scale below). Nunito is bundled locally; RN still scales these with Dynamic Type / font scale. Pick the
 * style by *role* (headline for row titles, footnote for meta…) and adjust
 * weight with `weight.*` only for emphasis — never invent sizes.
 */
const iosTypo = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: '700' },
  title1: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  title2: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  title3: { fontSize: 20, lineHeight: 25, fontWeight: '600' },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 17, lineHeight: 22, fontWeight: '400' },
  callout: { fontSize: 16, lineHeight: 21, fontWeight: '400' },
  subheadline: { fontSize: 15, lineHeight: 20, fontWeight: '400' },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  caption1: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
  caption2: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
} as const satisfies Record<string, TextStyle>;

/**
 * Android: the Material 3 type scale under the same role names (bodyLarge 16 /
 * 24, titleMedium 16 medium, bodyMedium 14, bodySmall 12…). Nunito uses the
 * platform-specific scale rather than reusing iOS point sizes. Weights stay as the roles expect.
 */
const androidTypo: { [K in keyof typeof iosTypo]: TextStyle } = {
  largeTitle: { fontSize: 32, lineHeight: 40, fontWeight: '700' },
  title1: { fontSize: 26, lineHeight: 34, fontWeight: '700' },
  title2: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  title3: { fontSize: 19, lineHeight: 26, fontWeight: '600' },
  headline: { fontSize: 16, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  callout: { fontSize: 15, lineHeight: 22, fontWeight: '400' },
  subheadline: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
  footnote: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
  caption1: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
  caption2: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
};

type Typo = { [K in keyof typeof iosTypo]: (typeof iosTypo)[K] & { fontFamily: string } };

const baseTypo = Object.fromEntries(
  Object.entries(Platform.OS === 'android' ? androidTypo : iosTypo).map(([role, style]) => [
    role,
    { ...style, fontFamily: 'Nunito' },
  ]),
) as Typo;

/** The in-app text size multiplier (src/theme/type-scale.ts), kept in step with the prefs store. */
let currentScale: number = TEXT_STEPS[DEFAULT_TEXT_STEP];
const scaledTypo = new Map<number, Typo>();
function typoAt(scale: number): Typo {
  let t = scaledTypo.get(scale);
  if (!t) {
    t = Object.fromEntries(Object.entries(baseTypo).map(([role, style]) => [role, scaleText(style, scale)])) as Typo;
    scaledTypo.set(scale, t);
  }
  return t;
}
usePrefs.subscribe((state) => {
  currentScale = TEXT_STEPS[state.textStep];
});

/**
 * The type ramp at the member's in-app text size (React Native adds Dynamic Type on top). Read
 * it inside makeStyles factories or render, never into module-scope constants: each read
 * answers the current size. Native bars and SwiftUI forms do not use it and follow the system.
 */
export const typo: Typo = new Proxy(baseTypo, {
  get: (_target, role: string) => typoAt(currentScale)[role as keyof Typo],
});

/** The ramp at the default size: chrome that follows only the system (tab and nav bar labels). */
export const systemTypo: Typo = baseTypo;

export { weight, space, radius, squircle, alpha, motion, HIT, shadow, mono } from './theme/shared';
