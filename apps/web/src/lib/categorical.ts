/**
 * User-chosen colours (project colours today) render through the categorical palette in
 * packages/ui/src/tokens/tokens.ts, never as the raw saturated hex a member once picked: a stored
 * hex snaps to the nearest categorical hue, and the CSS variable resolves per appearance.
 */

import { categorical, type CategoricalColor } from '@greenhouse/ui/tokens';

const HUES: Array<[CategoricalColor, number]> = [
  ['red', 4],
  ['orange', 25],
  ['amber', 42],
  ['green', 150],
  ['teal', 174],
  ['blue', 214],
  ['purple', 268],
  ['pink', 326],
];

/** The categorical colours offered when a member picks one (stored as their light `fg` hex). */
export const CATEGORICAL_CHOICES: CategoricalColor[] = [
  'blue',
  'purple',
  'teal',
  'amber',
  'red',
  'green',
  'pink',
  'orange',
];

export function categoricalHex(name: CategoricalColor): string {
  return categorical[name].fg.light;
}

/** The categorical colour nearest to a stored hex (gray for unsaturated or unreadable values). */
export function categoricalName(hex: string | null | undefined): CategoricalColor | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex?.trim() ?? '');
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  if (saturation < 0.18) return 'gray';
  let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  let best: CategoricalColor = 'gray';
  let bestDistance = Infinity;
  for (const [name, target] of HUES) {
    const distance = Math.min(Math.abs(hue - target), 360 - Math.abs(hue - target));
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

/** A stored colour as the mode-aware categorical `fg` (dots, bars), or `fallback` when unset. */
export function categoricalColor(hex: string | null | undefined, fallback = 'var(--t-fg-faint)'): string {
  const name = categoricalName(hex);
  return name ? `var(--t-cat-${name})` : fallback;
}

/** The soft fill paired with a stored colour, for chips and tinted backgrounds. */
export function categoricalFill(hex: string | null | undefined, fallback = 'var(--t-surface-muted)'): string {
  const name = categoricalName(hex);
  return name ? `var(--t-cat-${name}-fill)` : fallback;
}
