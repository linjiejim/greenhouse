/**
 * Session-tag color palette — mirrors apps/web/src/components/session-tags/colors.ts.
 *
 * The server stores a tag's color as a free-form hex string (DB default
 * #6B7280); the client offers this fixed 10-swatch palette. These are *data*
 * colors (they travel with the tag across web and mobile), so they stay hex
 * rather than system colors. Read a tag's color through `tagHex` (validated,
 * default gray) and derive washes with theme `alpha()`.
 */

import type { TranslationKey } from './i18n';

export const TAG_COLORS = [
  '#10B981', // green
  '#EF4444', // red
  '#3B82F6', // blue
  '#F59E0B', // yellow
  '#8B5CF6', // purple
  '#F97316', // orange
  '#EC4899', // pink
  '#6B7280', // gray
  '#14B8A6', // teal
  '#6366F1', // indigo
] as const;

/** Spoken names of the palette swatches (VoiceOver), index-aligned with TAG_COLORS. */
const TAG_COLOR_NAMES: readonly TranslationKey[] = [
  'tags.colorGreen',
  'tags.colorRed',
  'tags.colorBlue',
  'tags.colorYellow',
  'tags.colorPurple',
  'tags.colorOrange',
  'tags.colorPink',
  'tags.colorGray',
  'tags.colorTeal',
  'tags.colorIndigo',
];

/** i18n key naming a palette color (case-insensitive); null for off-palette hexes. */
export function tagColorNameKey(hex: string): TranslationKey | null {
  const i = TAG_COLORS.findIndex((c) => c.toLowerCase() === hex.toLowerCase());
  return i >= 0 ? TAG_COLOR_NAMES[i] : null;
}

/** DB default when a tag is created without a color. */
export const DEFAULT_TAG_COLOR = '#6B7280';

/**
 * The tag's color as a usable hex. Tag colors are free-form server data, so a
 * missing or unparseable value falls back to the DB default gray — callers
 * derive washes from the result with theme `alpha()`.
 */
export function tagHex(color: string | null | undefined): string {
  const c = color?.trim() ?? '';
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c) ? c : DEFAULT_TAG_COLOR;
}

/** A random palette color — the default swatch for a new tag. */
export function randomTagColor(): string {
  return TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)];
}
