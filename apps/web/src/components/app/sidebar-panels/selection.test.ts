import { describe, expect, it } from 'vitest';
import { pruneMissing, rangeSelect, toggleOne, type SelectableRow } from './selection';

/** A plain list where every session appears exactly once (`date:` bucket only). */
const rows: SelectableRow[] = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ key: `date:Today|${id}`, id }));
const k = (id: string) => `date:Today|${id}`;

describe('rangeSelect', () => {
  it('selects a forward inclusive span', () => {
    const result = rangeSelect(rows, k('b'), k('d'), new Set());
    expect([...result].sort()).toEqual(['b', 'c', 'd']);
  });

  it('selects a reverse span (anchor after target)', () => {
    const result = rangeSelect(rows, k('d'), k('b'), new Set());
    expect([...result].sort()).toEqual(['b', 'c', 'd']);
  });

  it('unions with the previous selection instead of replacing it', () => {
    const result = rangeSelect(rows, k('b'), k('c'), new Set(['e']));
    expect([...result].sort()).toEqual(['b', 'c', 'e']);
  });

  it('adds only the target when the anchor is missing', () => {
    expect([...rangeSelect(rows, null, k('c'), new Set())]).toEqual(['c']);
    expect([...rangeSelect(rows, 'zzz', k('c'), new Set())]).toEqual(['c']);
  });

  it('adds only the target when target equals anchor', () => {
    expect([...rangeSelect(rows, k('c'), k('c'), new Set())]).toEqual(['c']);
  });

  it('leaves the selection untouched when the target row is not visible', () => {
    const prev = new Set(['a']);
    expect([...rangeSelect(rows, k('a'), 'g:9|zzz', prev)]).toEqual(['a']);
  });

  it('respects the visible order — a collapsed row absent from rows is never swept in', () => {
    // 'c' is hidden (collapsed section) so it is not part of the visible order.
    const visible = rows.filter((r) => r.id !== 'c');
    const result = rangeSelect(visible, k('a'), k('d'), new Set());
    expect([...result].sort()).toEqual(['a', 'b', 'd']);
    expect(result.has('c')).toBe(false);
  });

  // Regression: Pinned is cross-cutting, so a pinned+filed session is rendered
  // twice. Ranging over bare session ids resolved the pinned copy at the top of
  // the list and swept in every row between it and the folder copy.
  it('ranges from the clicked occurrence, not the first one with that session id', () => {
    const dup: SelectableRow[] = [
      { key: 'pinned|p', id: 'p' }, // 'p' is pinned …
      { key: 'g:1|x', id: 'x' },
      { key: 'g:1|y', id: 'y' },
      { key: 'g:1|p', id: 'p' }, // … and also filed in folder 1
      { key: 'g:1|z', id: 'z' },
    ];
    // Shift-click the FOLDER copy of 'p' with the folder row 'z' as anchor.
    const result = rangeSelect(dup, 'g:1|z', 'g:1|p', new Set());
    expect([...result].sort()).toEqual(['p', 'z']);
    // 'x' and 'y' sit between the pinned copy and 'z' — they must stay untouched.
    expect(result.has('x')).toBe(false);
    expect(result.has('y')).toBe(false);
  });

  it('spans both copies when the range genuinely crosses them', () => {
    const dup: SelectableRow[] = [
      { key: 'pinned|p', id: 'p' },
      { key: 'g:1|x', id: 'x' },
      { key: 'g:1|p', id: 'p' },
    ];
    const result = rangeSelect(dup, 'pinned|p', 'g:1|p', new Set());
    expect([...result].sort()).toEqual(['p', 'x']);
  });
});

describe('toggleOne', () => {
  it('adds when absent and removes when present', () => {
    const added = toggleOne(new Set(['a']), 'b');
    expect([...added].sort()).toEqual(['a', 'b']);
    const removed = toggleOne(added, 'a');
    expect([...removed]).toEqual(['b']);
  });

  it('does not mutate the input set', () => {
    const prev = new Set(['a']);
    toggleOne(prev, 'b');
    expect([...prev]).toEqual(['a']);
  });
});

describe('pruneMissing', () => {
  it('drops ids that no longer exist', () => {
    const result = pruneMissing(new Set(['a', 'b', 'c']), ['a', 'c']);
    expect([...result].sort()).toEqual(['a', 'c']);
  });

  it('returns the same reference when nothing changed', () => {
    const prev = new Set(['a', 'b']);
    const result = pruneMissing(prev, new Set(['a', 'b', 'x']));
    expect(result).toBe(prev);
  });

  it('accepts a Set of existing ids', () => {
    const result = pruneMissing(new Set(['a', 'b']), new Set(['b']));
    expect([...result]).toEqual(['b']);
  });
});
