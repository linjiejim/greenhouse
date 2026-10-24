/**
 * A row's place in its inset-grouped card, for virtualized lists that cannot wrap rows in a
 * Section (src/ui/list.tsx draws the outer corners and hides the last separator). React-free.
 */

export type RowPosition = 'first' | 'middle' | 'last' | 'only';

export function rowPosition(index: number, count: number): RowPosition {
  if (count <= 1) return 'only';
  if (index === 0) return 'first';
  return index === count - 1 ? 'last' : 'middle';
}
