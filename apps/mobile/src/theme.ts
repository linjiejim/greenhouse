/**
 * Design tokens — iOS system colors + the Greenhouse Haven green accent.
 *
 * UIKit owns native controls and the dark system surfaces. Haven dynamic
 * overrides separate light reading planes and keep supporting text readable.
 * Appearance.setColorScheme keeps both palettes aligned with native chrome.
 * Use semantic roles in views; the React-free palette is their string mirror.
 *
 * Two views of the same palette:
 *  - `colors` — what views and text use. iOS: PlatformColor / DynamicColorIOS
 *    objects (opaque `ColorValue`s — never string-manipulate them). Android:
 *    the Material 3 palette seeded from the Haven green (./theme-m3.android.ts — the
 *    same one Compose views are themed with); web: the hex mirror.
 *  - `hex` — plain strings for the few places that need a real color string
 *    (react-native-svg drawing, alpha math, Swift widget assets). Mirrors the
 *    iOS values; keep both in sync when adding a token.
 *
 * Appearance: the in-app theme preference (system / light / dark) is applied
 * with `Appearance.setColorScheme`, which overrides the UIWindow's interface
 * style — so dynamic colors, native headers, sheets, menus and SwiftUI views
 * all follow the same choice. See `useApplyAppearance()` (called once in the
 * root layout).
 *
 * Styling: build a themed StyleSheet with `makeStyles((c) => ({...}))` at module
 * scope, then `const { colors: c } = useTheme(); const styles = useStyles(c);`.
 */

import { useEffect } from 'react';
import {
  Appearance,
  DynamicColorIOS,
  Platform,
  PlatformColor,
  StyleSheet,
  useColorScheme,
  type ColorValue,
  type TextStyle,
} from 'react-native';
import { usePrefs } from './store/prefs';
import { materialPalette } from './theme-m3';

/* ------------------------------ hex mirrors ------------------------------ */

import { lightHex, darkHex, type HexPalette } from './theme/palette';
export type { HexPalette } from './theme/palette';
const BRAND_LIGHT = lightHex.accent;

/* ---------------------------- Android palette ---------------------------- */

/** Brand seed of the Material 3 palette on Android (src/theme-m3.android.ts). */
export const SEED = BRAND_LIGHT;

const LIGHT = Platform.OS === 'android' ? materialPalette(lightHex, 'light', SEED) : lightHex;
const DARK = Platform.OS === 'android' ? materialPalette(darkHex, 'dark', SEED) : darkHex;

/* ------------------------------ iOS palette ------------------------------ */

export type ThemeColors = { [K in keyof HexPalette]: ColorValue };

/** UIKit semantic color names backing each token on iOS (null = brand/custom). */
const IOS_SYSTEM: Partial<Record<keyof HexPalette, string>> = {
  background: 'systemBackground',
  secondaryBackground: 'secondarySystemBackground',
  tertiaryBackground: 'tertiarySystemBackground',
  groupedBackground: 'systemGroupedBackground',
  secondaryGroupedBackground: 'secondarySystemGroupedBackground',
  tertiaryGroupedBackground: 'tertiarySystemGroupedBackground',
  label: 'label',
  secondaryLabel: 'secondaryLabel',
  tertiaryLabel: 'tertiaryLabel',
  quaternaryLabel: 'quaternaryLabel',
  placeholder: 'placeholderText',
  separator: 'separator',
  opaqueSeparator: 'opaqueSeparator',
  fill: 'systemFill',
  secondaryFill: 'secondarySystemFill',
  tertiaryFill: 'tertiarySystemFill',
  quaternaryFill: 'quaternarySystemFill',
  red: 'systemRed',
  orange: 'systemOrange',
  yellow: 'systemYellow',
  green: 'systemGreen',
  blue: 'systemBlue',
  indigo: 'systemIndigo',
  purple: 'systemPurple',
  gray: 'systemGray',
  bubble: 'secondarySystemBackground',
};

function buildIosPalette(): ThemeColors {
  const out = {} as Record<keyof HexPalette, ColorValue>;
  for (const key of Object.keys(lightHex) as (keyof HexPalette)[]) {
    const system = IOS_SYSTEM[key];
    const lightOverride = [
      'background',
      'secondaryBackground',
      'groupedBackground',
      'secondaryLabel',
      'tertiaryLabel',
      'placeholder',
      'separator',
      'opaqueSeparator',
      'bubble',
    ].includes(key);
    out[key] = lightOverride
      ? DynamicColorIOS({
          light: lightHex[key],
          dark: ['tertiaryLabel', 'placeholder'].includes(key)
            ? darkHex[key]
            : system
              ? PlatformColor(system)
              : darkHex[key],
        })
      : system
        ? PlatformColor(system)
        : DynamicColorIOS({ light: lightHex[key], dark: darkHex[key] });
  }
  return out;
}

const iosPalette: ThemeColors | null = Platform.OS === 'ios' ? buildIosPalette() : null;

/**
 * The active palette. On iOS `colors` is one stable object (dynamic colors
 * resolve natively), so styles never need rebuilding on a scheme change; the
 * `hex` mirror and `isDark` still follow the scheme for SVG / string needs.
 */
export function useTheme(): { colors: ThemeColors; hex: HexPalette; isDark: boolean } {
  const scheme = useColorScheme();
  const pref = usePrefs((s) => s.theme);
  const isDark = pref === 'dark' || (pref === 'system' && scheme === 'dark');
  const hex = isDark ? DARK : LIGHT;
  return { colors: iosPalette ?? hex, hex, isDark };
}

/**
 * Apply the in-app theme preference to the whole UI (UIKit trait override), so
 * PlatformColors, native headers, sheets, menus and SwiftUI follow it. Call
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
  const cache = new Map<ThemeColors, T>();
  return (c: ThemeColors): T => {
    let s = cache.get(c);
    if (!s) {
      s = StyleSheet.create(fn(c));
      cache.set(c, s);
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
  caption2: { fontSize: 11, lineHeight: 13, fontWeight: '400' },
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
  caption2: { fontSize: 11, lineHeight: 16, fontWeight: '400' },
};

export const typo = Object.fromEntries(
  Object.entries(Platform.OS === 'android' ? androidTypo : iosTypo).map(([role, style]) => [
    role,
    { ...style, fontFamily: 'Nunito' },
  ]),
) as { [K in keyof typeof iosTypo]: (typeof iosTypo)[K] & { fontFamily: string } };

/** The only font weights in use — name them so call sites read intent. */
export const weight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

/* ------------------------------ layout ------------------------------ */

/** 4-pt spacing scale; `margin` is the iPhone layout margin (16). */
export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32, margin: 16 } as const;

/**
 * Corner radii. Pair every rounded rect with `borderCurve: 'continuous'`
 * (`squircle`) for the native iOS shape. `group` matches inset-grouped list
 * sections; `bubble` the chat bubbles.
 */
export const radius = { xs: 6, sm: 8, md: 12, lg: 16, xl: 22, group: 26, bubble: 20, full: 999 } as const;

/** Spread into any rounded style: iOS continuous (squircle) corners. */
export const squircle = { borderCurve: 'continuous' } as const;

/**
 * A real color string at opacity `a` (0–1), for data-driven colors (tag /
 * project hexes) and the `hex.*` mirror — never for `colors.*`, which are
 * opaque native color objects. Accepts `#RGB`, `#RRGGBB`, `#RRGGBBAA` and
 * `rgb()/rgba()` (an existing alpha is multiplied); anything else is returned
 * unchanged.
 *
 *   alpha(tag.color, 0.12)   // a faint wash of the tag's color
 */
export function alpha(color: string, a: number): string {
  const src = color.trim();
  let rgb: number[];
  let base = 1;
  if (src.startsWith('#')) {
    let h = src.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('');
    if (h.length !== 6 && h.length !== 8) return color;
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    if (h.length === 8) base = parseInt(h.slice(6, 8), 16) / 255;
  } else {
    const parts = /^rgba?\(([^)]+)\)$/i
      .exec(src)?.[1]
      .split(',')
      .map((p) => parseFloat(p));
    if (!parts || parts.length < 3) return color;
    rgb = parts.slice(0, 3);
    if (parts.length > 3) base = parts[3];
  }
  if (rgb.some((n) => Number.isNaN(n)) || Number.isNaN(base)) return color;
  const out = Math.round(Math.min(1, Math.max(0, base * a)) * 1000) / 1000;
  return `rgba(${rgb.map(Math.round).join(',')},${out})`;
}

/** Minimum touch target (HIG). */
export const HIT = 44;

/** Soft elevation for the rare floating element that isn't glass. */
export const shadow = {
  float: {
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
} as const;

export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) as string;
