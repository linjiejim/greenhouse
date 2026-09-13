/**
 * The two pure pieces of the tree drag: which band of a row the pointer is in,
 * and the sibling order a drop produces. The index bookkeeping is where an
 * off-by-one hides silently (it looks like "the drop just didn't take").
 */

import { describe, it, expect } from 'vitest';
import { computeOrder, isSameOrder, resolveIntent } from './use-tree-drag';

const row = { top: 100, height: 30 };

describe('resolveIntent', () => {
  it('splits a folder row into before / into / after', () => {
    expect(resolveIntent(row, 102, true)).toBe('before'); // top band
    expect(resolveIntent(row, 115, true)).toBe('into'); // middle
    expect(resolveIntent(row, 128, true)).toBe('after'); // bottom band
  });

  it('splits a row with no inside in half', () => {
    expect(resolveIntent(row, 110, false)).toBe('before');
    expect(resolveIntent(row, 120, false)).toBe('after');
    // Never 'into' — a document cannot contain anything.
    expect(resolveIntent(row, 115, false)).not.toBe('into');
  });

  it('survives a zero-height row instead of dividing by zero', () => {
    expect(resolveIntent({ top: 0, height: 0 }, 0, true)).toBe('before');
    expect(resolveIntent({ top: 0, height: 0 }, 0, false)).toBe('before');
  });
});

describe('computeOrder', () => {
  it('moves an item later, accounting for its own removal', () => {
    // [1,2,3,4], drop 1 at index 3 → it lands between 3 and 4, not after 4.
    expect(computeOrder([1, 2, 3, 4], 1, 3)).toEqual([2, 3, 1, 4]);
  });

  it('moves an item earlier without shifting', () => {
    expect(computeOrder([1, 2, 3, 4], 4, 1)).toEqual([1, 4, 2, 3]);
  });

  it('inserts a node arriving from another parent', () => {
    expect(computeOrder([1, 2, 3], 9, 1)).toEqual([1, 9, 2, 3]);
    expect(computeOrder([1, 2, 3], 9, 0)).toEqual([9, 1, 2, 3]);
    expect(computeOrder([1, 2, 3], 9, 3)).toEqual([1, 2, 3, 9]);
  });

  it('clamps an out-of-range index rather than producing holes', () => {
    expect(computeOrder([1, 2], 9, 99)).toEqual([1, 2, 9]);
    expect(computeOrder([1, 2], 9, -5)).toEqual([9, 1, 2]);
  });

  it('is a no-op when the item is dropped back where it started', () => {
    const current = [1, 2, 3];
    expect(isSameOrder(current, computeOrder(current, 2, 1))).toBe(true);
    expect(isSameOrder(current, computeOrder(current, 2, 2))).toBe(true); // same slot, other edge
    expect(isSameOrder(current, computeOrder(current, 2, 0))).toBe(false);
  });
});
