/**
 * Design tokens — iOS system colors + the Greenhouse Teal accent.
 *
 * The app follows the iOS Human Interface Guidelines: surfaces, text,
 * separators and fills are the *system semantic colors* (on iOS they are
 * `PlatformColor`s, so they track light/dark, Increased Contrast and every iOS
 * release exactly), and brand identity comes from a single tint — Teal — used
 * for interactive elements, selection and the brand mascot. Never hard-code a
 * hex for a surface or text: pick the semantic token.
 *
 * Two views of the same palette:
 *  - `colors` — what views and text use. iOS: PlatformColor / DynamicColorIOS
 *    objects (opaque `ColorValue`s — never string-manipulate them). Android /
 *    web: the hex mirror of the active scheme.
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

/* ------------------------------ hex mirrors ------------------------------ */

/** Brand Teal (web --primary-600 light / a brighter teal for dark, iOS-style). */
const TEAL_LIGHT = '#0D9488';
const TEAL_DARK = '#2DD4BF';

const lightHex = {
  // ── Brand ──
  accent: TEAL_LIGHT,
  /** Text/icons on a filled accent surface. */
  onAccent: '#FFFFFF',
  /** Tinted fill behind accent content (selected rows, AI avatar, chips). */
  accentFill: 'rgba(13,148,136,0.12)',
  /** Accent-colored text that must stay readable on `accentFill`. */
  accentText: '#0F766E',
  /**
   * Glyphs / text on a filled *non-accent* color (a system-color icon tile, a
   * gray avatar, a project's color) — white in both schemes, like the icons
   * in iOS Settings. On the accent itself use `onAccent`.
   */
  onTint: '#FFFFFF',

  // ── Backgrounds (plain + grouped) ──
  background: '#FFFFFF',
  secondaryBackground: '#F2F2F7',
  tertiaryBackground: '#FFFFFF',
  groupedBackground: '#F2F2F7',
  secondaryGroupedBackground: '#FFFFFF',
  tertiaryGroupedBackground: '#F2F2F7',

  // ── Text ──
  label: '#000000',
  secondaryLabel: 'rgba(60,60,67,0.6)',
  tertiaryLabel: 'rgba(60,60,67,0.3)',
  quaternaryLabel: 'rgba(60,60,67,0.18)',
  placeholder: 'rgba(60,60,67,0.3)',
  link: TEAL_LIGHT,

  // ── Separators / fills ──
  separator: 'rgba(60,60,67,0.29)',
  opaqueSeparator: '#C6C6C8',
  fill: 'rgba(120,120,128,0.2)',
  secondaryFill: 'rgba(120,120,128,0.16)',
  tertiaryFill: 'rgba(118,118,128,0.12)',
  quaternaryFill: 'rgba(116,116,128,0.08)',

  // ── System colors (status / semantics) ──
  red: '#FF3B30',
  orange: '#FF9500',
  yellow: '#FFCC00',
  green: '#34C759',
  blue: '#007AFF',
  indigo: '#5856D6',
  purple: '#AF52DE',
  gray: '#8E8E93',
  redFill: 'rgba(255,59,48,0.12)',
  orangeFill: 'rgba(255,149,0,0.14)',
  greenFill: 'rgba(52,199,89,0.14)',
  blueFill: 'rgba(0,122,255,0.12)',

  // ── Chat ──
  /** The user's message bubble. */
  bubble: '#F2F2F7',

  // ── Code blocks (always dark, both schemes) ──
  codeBg: '#1C1C1E',
  codeHeader: '#2C2C2E',
  codeText: '#E5E5EA',
  codeComment: '#8E8E93',
  codeLabel: '#AEAEB2',

  /** Dimming layer under the drawer / custom overlays. */
  scrim: 'rgba(0,0,0,0.22)',
};

export type HexPalette = typeof lightHex;

const darkHex: HexPalette = {
  accent: TEAL_DARK,
  onAccent: '#04201D',
  accentFill: 'rgba(45,212,191,0.16)',
  accentText: '#5EEAD4',
  onTint: '#FFFFFF',

  background: '#000000',
  secondaryBackground: '#1C1C1E',
  tertiaryBackground: '#2C2C2E',
  groupedBackground: '#000000',
  secondaryGroupedBackground: '#1C1C1E',
  tertiaryGroupedBackground: '#2C2C2E',

  label: '#FFFFFF',
  secondaryLabel: 'rgba(235,235,245,0.6)',
  tertiaryLabel: 'rgba(235,235,245,0.3)',
  quaternaryLabel: 'rgba(235,235,245,0.16)',
  placeholder: 'rgba(235,235,245,0.3)',
  link: TEAL_DARK,

  separator: 'rgba(84,84,88,0.6)',
  opaqueSeparator: '#38383A',
  fill: 'rgba(120,120,128,0.36)',
  secondaryFill: 'rgba(120,120,128,0.32)',
  tertiaryFill: 'rgba(118,118,128,0.24)',
  quaternaryFill: 'rgba(118,118,128,0.18)',

  red: '#FF453A',
  orange: '#FF9F0A',
  yellow: '#FFD60A',
  green: '#30D158',
  blue: '#0A84FF',
  indigo: '#5E5CE6',
  purple: '#BF5AF2',
  gray: '#8E8E93',
  redFill: 'rgba(255,69,58,0.18)',
  orangeFill: 'rgba(255,159,10,0.18)',
  greenFill: 'rgba(48,209,88,0.18)',
  blueFill: 'rgba(10,132,255,0.18)',

  bubble: '#1C1C1E',

  codeBg: '#1C1C1E',
  codeHeader: '#2C2C2E',
  codeText: '#E5E5EA',
  codeComment: '#8E8E93',
  codeLabel: '#AEAEB2',

  scrim: 'rgba(0,0,0,0.45)',
};

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
    out[key] = system ? PlatformColor(system) : DynamicColorIOS({ light: lightHex[key], dark: darkHex[key] });
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
  const isDark = scheme === 'dark';
  const hex = isDark ? darkHex : lightHex;
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
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(
  fn: (c: ThemeColors) => T,
): (c: ThemeColors) => T {
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
 * iOS text styles (HIG, default "Large" content size). SF Pro is the system
 * font, so no fontFamily is set; RN scales these with Dynamic Type. Pick the
 * style by *role* (headline for row titles, footnote for meta…) and adjust
 * weight with `weight.*` only for emphasis — never invent sizes.
 */
export const typo = {
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
    const parts = /^rgba?\(([^)]+)\)$/i.exec(src)?.[1].split(',').map((p) => parseFloat(p));
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
