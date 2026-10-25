import { describe, expect, it } from 'vitest';
import { statsLayout } from './business-blocks';

/** Cells on the last row once the last item spans the remainder: never a lone half-width cell. */
function lastRow(count: number, columns: number, span: number) {
  const rest = count % columns || columns;
  return rest - 1 + span;
}

describe('stats grid layout', () => {
  it('fills the last row in both layouts for every count up to 12', () => {
    for (let count = 1; count <= 12; count++) {
      const layout = statsLayout(count);
      expect(lastRow(count, layout.wide, layout.spanWide), `wide ${count}`).toBe(Math.min(layout.wide, count));
      expect(lastRow(count, layout.narrow, layout.spanNarrow), `narrow ${count}`).toBe(Math.min(layout.narrow, count));
    }
  });

  it('puts three figures on one row on a phone instead of 2 + 1', () => {
    expect(statsLayout(3)).toMatchObject({ narrow: 3, spanNarrow: 1 });
  });

  it('keeps at most four columns wide and three narrow', () => {
    for (let count = 1; count <= 12; count++) {
      expect(statsLayout(count).wide).toBeLessThanOrEqual(4);
      expect(statsLayout(count).narrow).toBeLessThanOrEqual(3);
    }
  });
});
