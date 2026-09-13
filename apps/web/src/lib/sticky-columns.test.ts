import { describe, expect, it } from 'vitest';

import {
  STICKY_CELL_SURFACE,
  STICKY_HEADER_SURFACE,
  STICKY_LEFT_CELL,
  STICKY_LEFT_HEADER,
  STICKY_RIGHT_CELL,
  STICKY_RIGHT_HEADER,
} from './sticky-columns';

/**
 * These are class-name constants, so the value worth testing is not the strings
 * themselves but the two invariants the module exists to hold — both of which
 * have already been broken once in a way no type check could catch.
 */

/** `z-20` and `z-[5]` both resolve to a number so the layers can be compared. */
function zIndexOf(classes: string): number {
  const match = /(?:^|\s)z-(?:\[(\d+)\]|(\d+))(?:\s|$)/.exec(classes);
  expect(match, `no z-index in "${classes}"`).not.toBeNull();
  return Number(match?.[1] ?? match?.[2]);
}

describe('pinned column classes', () => {
  const headers = { left: STICKY_LEFT_HEADER, right: STICKY_RIGHT_HEADER };
  const cells = { left: STICKY_LEFT_CELL, right: STICKY_RIGHT_CELL };

  it('pins every layer to the edge it names', () => {
    expect(STICKY_LEFT_HEADER).toContain('left-0');
    expect(STICKY_LEFT_CELL).toContain('left-0');
    expect(STICKY_RIGHT_HEADER).toContain('right-0');
    expect(STICKY_RIGHT_CELL).toContain('right-0');
    for (const classes of [...Object.values(headers), ...Object.values(cells)]) {
      expect(classes.split(/\s+/)).toContain('sticky');
    }
  });

  it('keeps header cells above body cells, and both above the sticky thead', () => {
    // A scrolled-under column painting over a pinned one is the bug this ordering
    // prevents: a stray z-30 on a header icon button once put "Stage" on top of
    // the frozen "Owner" cell.
    const theadZ = 10;
    for (const side of ['left', 'right'] as const) {
      expect(zIndexOf(headers[side])).toBeGreaterThan(zIndexOf(cells[side]));
      expect(zIndexOf(headers[side])).toBeGreaterThan(theadZ);
      expect(zIndexOf(cells[side])).toBeLessThan(theadZ);
    }
  });

  it('gives pinned cells an opaque background so scrolled columns cannot show through', () => {
    // A pinned cell is painted over the scrolling ones; without its own background
    // — and the row's hover background — they read straight through it.
    expect(STICKY_CELL_SURFACE).toMatch(/(^|\s)bg-\S+/);
    expect(STICKY_CELL_SURFACE).toMatch(/(^|\s)group-hover:bg-\S+/);
    expect(STICKY_HEADER_SURFACE).toMatch(/(^|\s)bg-\S+/);
    for (const surface of [STICKY_CELL_SURFACE, STICKY_HEADER_SURFACE]) {
      expect(surface).not.toMatch(/bg-transparent/);
    }
  });
});
