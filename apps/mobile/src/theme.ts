/**
 * Design tokens — Greenhouse Teal, mirrored from the web design system
 * (packages/ui/src/styles/tokens.css is the canonical source; keep the two in
 * sync when the web palette changes). Plain JS objects so every screen uses
 * native StyleSheet (no Tailwind).
 *
 * Two palettes (light/dark) behind `useTheme()`: theme preference lives in
 * prefs ('system' follows useColorScheme). Component styles are built with
 * `makeStyles((c) => ({...}))` factories so palette swaps need no call-site
 * changes beyond the hook.
 */

import { Platform, StyleSheet, useColorScheme } from 'react-native';
import { usePrefs } from './store/prefs';

const light = {
  // ── Brand Teal (web --primary-*) ──
  accent: '#0d9488', // primary-600: buttons, active icon/text, brand
  accentStrong: '#0f766e', // primary-700: pressed / strong active
  accentDeep: '#115e59', // primary-800: strongest pressed / on-tint text
  accentTint: '#f0fdfa', // primary-50: active-chip bg, AI avatar bg, subtle fills
  accentBorder: '#99f6e4', // primary-200: border on tinted surfaces

  // ── Neutral / surfaces ──
  bg: '#f9fafb', // app background (sunken)
  surface: '#ffffff', // cards, composer, sheets
  surfaceMuted: '#f3f4f6', // pressed rows, input fill
  hairline: '#e5e7eb', // dividers / borders
  hairlineStrong: '#d1d5db', // input borders

  // ── Text ──
  fg: '#111827',
  fgSecondary: '#4b5563',
  fgMuted: '#6b7280',
  fgFaint: '#9ca3af',
  onAccent: '#ffffff',

  // ── Status (web --t-success/-warning/-danger/-info) ──
  success: '#059669',
  warning: '#d97706',
  danger: '#dc2626',
  info: '#2563eb',
  successTint: '#ecfdf5',
  warningTint: '#fffbeb',
  dangerTint: '#fef2f2',
  infoTint: '#eff6ff',

  // ── Code block (always dark, both themes) ──
  codeBg: '#0f1720',
  codeHeader: '#152030',
  codeText: '#d6e2ef',
  codeComment: '#6b8299',
  codeLabel: '#8aa0b8',

  // user avatar gradient ends (steel)
  userAvatarA: '#7c8aa0',
  userAvatarB: '#5b6b82',

  // scrim / overlay
  scrim: 'rgba(17,24,39,0.34)',
};

export type ThemeColors = typeof light;

const dark: ThemeColors = {
  // Dark accents are the light teals (web dark --t-primary-fg family); text on
  // them must be dark.
  accent: '#5eead4', // primary-300
  accentStrong: '#99f6e4', // primary-200
  accentDeep: '#ccfbf1', // primary-100
  accentTint: 'rgba(20,184,166,0.12)', // --t-primary-subtle (dark)
  accentBorder: 'rgba(20,184,166,0.25)', // --t-primary-edge (dark)

  bg: '#0f172a', // slate-900 (midnight)
  surface: '#1e293b', // slate-800 (raised)
  surfaceMuted: '#334155', // slate-700
  hairline: '#334155',
  hairlineStrong: '#475569',

  fg: '#f8fafc',
  fgSecondary: '#cbd5e1',
  fgMuted: '#94a3b8',
  fgFaint: '#64748b',
  onAccent: '#042f2e', // dark teal text on light-teal accent

  success: '#34d399',
  warning: '#fbbf24',
  danger: '#f87171',
  info: '#60a5fa',
  successTint: 'rgba(16,185,129,0.12)',
  warningTint: 'rgba(245,158,11,0.12)',
  dangerTint: 'rgba(239,68,68,0.12)',
  infoTint: 'rgba(59,130,246,0.12)',

  codeBg: '#0f1720',
  codeHeader: '#152030',
  codeText: '#d6e2ef',
  codeComment: '#6b8299',
  codeLabel: '#8aa0b8',

  userAvatarA: '#64748b',
  userAvatarB: '#475569',

  scrim: 'rgba(0,0,0,0.5)',
};

export const palettes = { light, dark } as const;

/** Resolve the active palette from the theme preference + system scheme. */
export function useTheme(): { colors: ThemeColors; isDark: boolean } {
  const system = useColorScheme();
  const pref = usePrefs((s) => s.theme);
  const isDark = pref === 'dark' || (pref === 'system' && system === 'dark');
  return { colors: isDark ? dark : light, isDark };
}

/**
 * Build a themed StyleSheet factory. Define once at module scope:
 *   const useStyles = makeStyles((c) => ({ root: { backgroundColor: c.bg } }));
 * then inside the component:
 *   const { colors: c } = useTheme();
 *   const styles = useStyles(c);
 * Sheets are created once per palette and cached.
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

export const radius = { sm: 8, md: 10, lg: 14, xl: 18, full: 999 } as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/** Type scale (px). */
export const font = {
  caption: 12,
  label: 14,
  body: 15,
  heading: 18,
  title: 22,
  display: 30,
} as const;

/** Reusable shadows (iOS shadow* + Android elevation). */
export const shadow = {
  card: {
    shadowColor: '#111827',
    shadowOpacity: 0.06,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  lift: {
    shadowColor: '#111827',
    shadowOpacity: 0.1,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
  accent: {
    shadowColor: '#0d9488',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
  },
} as const;

export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) as string;
