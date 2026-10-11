/**
 * The select options a builder edits, as rows that carry the option they came
 * from. Records store option ids, so an option's id must follow the option —
 * not its line: renaming keeps the id, reordering moves it with the row,
 * removing drops it (and its id is never handed to a new option). Pure; the
 * editor is `./option-list-editor.tsx`.
 */

import type { TableSelectOption } from '@greenhouse/types/tables';

export interface OptionRow {
  /** Stable React key for the row. */
  key: string;
  /** The stored option this row edits; absent for a new one. */
  option?: TableSelectOption;
  label: string;
}

let nextKey = 0;
const rowKey = () => `row-${++nextKey}`;

export function optionRows(options: readonly TableSelectOption[] | undefined): OptionRow[] {
  return (options ?? []).map((option) => ({ key: rowKey(), option, label: option.label }));
}

export function newOptionRow(label = ''): OptionRow {
  return { key: rowKey(), label };
}

/** An id for a new option: from the label when it has letters or digits, never one in `taken`. */
function freshId(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'option';
  let suffix = 1;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  const id = `${base}-${suffix}`;
  taken.add(id);
  return id;
}

/**
 * The options to store. Blank rows are skipped; a stored option keeps its id
 * and colour under its (new) label; a new one gets an id that no stored option
 * — kept or removed — has ever had, so a removed option's records never turn
 * into the new one.
 */
export function optionsFromRows(
  rows: readonly OptionRow[],
  stored: readonly TableSelectOption[] | undefined,
): TableSelectOption[] {
  const taken = new Set((stored ?? []).map((option) => option.id));
  return rows.flatMap((row): TableSelectOption[] => {
    const label = row.label.trim();
    if (!label) return [];
    return row.option ? [{ ...row.option, label }] : [{ id: freshId(label, taken), label }];
  });
}

/** Rows with `index` moved by `delta` (−1 up, +1 down); unchanged at the ends. */
export function moveRow(rows: readonly OptionRow[], index: number, delta: -1 | 1): OptionRow[] {
  const target = index + delta;
  if (target < 0 || target >= rows.length) return [...rows];
  const next = [...rows];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
