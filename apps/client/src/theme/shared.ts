import { Platform } from 'react-native';
import { motionTokens, radiusScale } from './tokens.generated';

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
 * Corner radii from the shared scale (packages/ui/src/tokens/tokens.ts, via ./theme/tokens.generated.ts;
 * names here keep the app's own steps: xs 6 = sm, sm 8 = md, md 12 = lg, lg 16 = xl, xl 20 = 2xl).
 * Pair every rounded rect with `borderCurve: 'continuous'` (`squircle`) for the native iOS shape.
 * `bubble` (20) is the scale's 2xl. `group` is the one native exception: it matches the corners
 * UIKit gives inset-grouped list sections (26 on iOS 26), so RN cards sit flush with SwiftUI forms.
 */
export const radius = {
  xs: radiusScale.sm,
  sm: radiusScale.md,
  md: radiusScale.lg,
  lg: radiusScale.xl,
  xl: radiusScale['2xl'],
  group: 26,
  bubble: radiusScale['2xl'],
  full: 999,
} as const;

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

/** Motion durations (shared tokens, ms); system navigation owns its own transitions. */
export const motion = {
  fast: motionTokens.fast,
  base: motionTokens.base,
  slow: motionTokens.slow,
  exit: motionTokens.exit,
} as const;

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
