/**
 * Session-tag color palette — mirrors apps/web/src/components/session-tags/colors.ts.
 *
 * The server stores a tag's color as a free-form hex string (DB default
 * #6B7280); the client offers this fixed 10-swatch palette. Chip styling:
 * fill = color @ 12% (…20 suffix), border = color @ 25% (…40), dot + text = solid.
 */

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

/** DB default when a tag is created without a color. */
export const DEFAULT_TAG_COLOR = '#6B7280';

/** Append an 8-bit alpha suffix to a #RRGGBB hex, e.g. withAlpha('#10B981', '20'). */
export function withAlpha(hex: string, alpha: string): string {
  const base = hex.length >= 7 ? hex.slice(0, 7) : hex;
  return `${base}${alpha}`;
}

/** A random palette color — used for the quick inline "create tag" flow. */
export function randomTagColor(): string {
  return TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)];
}
