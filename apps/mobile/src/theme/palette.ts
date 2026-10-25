/**
 * Greenhouse colours for RN content, as strings (React-free, so ./palette.test.ts checks contrast
 * without a native install). Every value comes from the shared token module
 * (packages/ui/src/tokens/tokens.ts) through ./tokens.generated.ts — run `pnpm tokens:build` at the
 * repo root after changing a token; never edit a hex here.
 *
 * Light: Haven forest green on neutral, faintly green surfaces. Dark: content surfaces keep
 * UIKit's system base (#000 under #1C1C1E grouped cells) so RN content and native Hosts never mix
 * traits; the accent is the pale sage. Native controls keep system styling with the accent as tint.
 */

import { categoricalHex, nativePalette } from './tokens.generated';

type Widen<T> = { [K in keyof T]: string };

export type HexPalette = Widen<typeof nativePalette.light>;

export const lightHex: HexPalette = { ...nativePalette.light };
export const darkHex: HexPalette = { ...nativePalette.dark };

export type CategoricalName = keyof typeof categoricalHex.light;
export type CategoricalPair = { fg: string; fill: string };

/** User-chosen colours (project and tag colours) as fg-on-fill pairs per appearance. */
export const categorical: Record<'light' | 'dark', Record<CategoricalName, CategoricalPair>> = categoricalHex;

const CATEGORICAL_HUES: Array<[CategoricalName, number]> = [
  ['red', 4],
  ['orange', 25],
  ['amber', 42],
  ['green', 150],
  ['teal', 174],
  ['blue', 214],
  ['purple', 268],
  ['pink', 326],
];

/**
 * A user-chosen colour (a project's or tag's stored hex) as the categorical fg/fill pair for the
 * appearance: the nearest categorical hue, gray when unsaturated, null when unreadable. Draw dots,
 * bars and icons in `fg`, chips on `fill` with `fg` text — never the raw saturated hex. Same rule
 * as the web's apps/web/src/lib/categorical.ts.
 */
export function categoricalFor(hex: string | null | undefined, isDark: boolean): CategoricalPair | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex?.trim() ?? '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  const set = categorical[isDark ? 'dark' : 'light'];
  if (saturation < 0.18) return set.gray;
  let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  let best: CategoricalName = 'gray';
  let bestDistance = Infinity;
  for (const [name, target] of CATEGORICAL_HUES) {
    const distance = Math.min(Math.abs(hue - target), 360 - Math.abs(hue - target));
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return set[best];
}
