/**
 * Pinned first/last columns for wide list tables.
 *
 * On a table wide enough to scroll sideways, the two columns that must never
 * leave are the one that says which row this is and the one that acts on it —
 * otherwise you scroll right to read a value and no longer know whose value it
 * is, or which row the delete button belongs to.
 *
 * A pinned body cell needs its OWN opaque background plus the row's hover
 * background: it is painted over the scrolling columns, and a transparent one
 * lets them show through. Surfaces differ per table (Tables sits on
 * `surface-raised`, CRM rows hover to `surface-muted`), so the surface classes
 * stay with the caller and only the positioning and z-order live here.
 *
 * z-order: header cells sit above body cells, and both sit above the plain
 * columns they cover; the sticky `thead` itself is `z-10`.
 */

export const STICKY_LEFT_HEADER = 'sticky left-0 z-20';
export const STICKY_RIGHT_HEADER = 'sticky right-0 z-20';
export const STICKY_LEFT_CELL = 'sticky left-0 z-[5]';
export const STICKY_RIGHT_CELL = 'sticky right-0 z-[5]';

/** What a pinned CRM body cell needs so scrolled columns cannot show through. */
export const STICKY_CELL_SURFACE = 'bg-surface-raised group-hover:bg-surface-muted';

/** Matching surface for a pinned CRM header cell. */
export const STICKY_HEADER_SURFACE = 'bg-surface-muted';
