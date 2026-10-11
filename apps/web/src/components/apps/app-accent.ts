/**
 * App accent → semantic token classes. An app's accent (`APP_ACCENTS`) is an
 * identity colour, not a status: `brand` is the primary tint, `slate` the
 * neutral surface, the rest their own `--t-accent-*` tokens
 * (packages/ui/src/styles/tokens.css, light + dark, contrast-checked in
 * lib/theme-contrast.test.ts). Never write a colour value here.
 */

import type { AppAccent } from '@greenhouse/types/apps';

/** Tile fill + glyph colour, as whole class strings so Tailwind sees them. */
export const APP_ACCENT_CLASSES: Record<AppAccent, string> = {
  brand: 'bg-primary-subtle text-primary-fg-strong',
  blue: 'bg-accent-blue-subtle text-accent-blue',
  teal: 'bg-accent-teal-subtle text-accent-teal',
  amber: 'bg-accent-amber-subtle text-accent-amber',
  rose: 'bg-accent-rose-subtle text-accent-rose',
  violet: 'bg-accent-violet-subtle text-accent-violet',
  slate: 'bg-surface-muted text-fg-secondary',
};

/** Classes for an accent name; an unknown one (an older client, a newer server) draws as `brand`. */
export function appAccentClasses(accent: string | null | undefined): string {
  return accent && Object.hasOwn(APP_ACCENT_CLASSES, accent)
    ? APP_ACCENT_CLASSES[accent as AppAccent]
    : APP_ACCENT_CLASSES.brand;
}
