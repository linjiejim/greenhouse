/**
 * Import values — the text of one spreadsheet cell → a field value, plus the
 * column helpers only an import needs.
 *
 * Reading cell text is `@greenhouse/types/table-cell-text` (`coerceTableCellText`,
 * shared with the grid's paste, so whatever imports also pastes). What is left
 * here is import-only: linked records matched by primary text among the records
 * the writer may read (D14 — the caller hands in those labels), column type
 * inference for new fields, header ↔ field-name matching, and the select
 * options a column would add. Pure (no database); the record write still
 * validates everything again, so this module decides *meaning*, never permission.
 */

import {
  cellSelectLabels,
  cellTextHasTime,
  coerceTableCellText,
  findCellOption,
  inferCellDateOrder,
  normalizeCellText,
  parseCellBoolean,
  parseCellDate,
  parseCellDateTime,
  parseCellEmail,
  parseCellNumber,
  shownCellText,
  splitCellList,
  tableCellTextFailure,
  type TableCellTextContext,
  type TableCellTextField,
  type TableCellTextResult,
} from '@greenhouse/types/table-cell-text';
import type { TableFieldType, TableSelectOption } from '@greenhouse/types/tables';

export interface ImportField extends TableCellTextField {
  id: number;
}

export interface ImportValueContext extends TableCellTextContext {
  /**
   * Relation fields only: the target table's primary text → record ids, limited
   * to records the writer may read. Undefined = the target is not available to
   * the writer, so no label matches.
   */
  relationLabels?: ReadonlyMap<string, readonly number[]>;
}

/** Labels a new select option may carry (the option validator's limit). */
const MAX_OPTION_LABEL = 100;
const MAX_SELECT_OPTIONS = 100;

// ─── Cells ────────────────────────────────────────────────

function linkedRecords(field: ImportField, label: string, ctx: ImportValueContext): TableCellTextResult {
  const labels = ctx.relationLabels;
  if (!labels) return tableCellTextFailure(field, 'the linked table is not available to you');
  const multiple = field.config.relation?.multiple === true;
  const parts = labels.has(label) || !multiple ? [label] : splitCellList(label);
  const ids: number[] = [];
  for (const part of parts) {
    const matches = labels.get(part) ?? [];
    if (matches.length === 0) return tableCellTextFailure(field, `no linked record named "${shownCellText(part)}"`);
    if (matches.length > 1)
      return tableCellTextFailure(field, `"${shownCellText(part)}" matches several linked records`);
    if (!ids.includes(matches[0]!)) ids.push(matches[0]!);
  }
  return { ok: true, value: multiple ? ids : ids[0] };
}

/**
 * One cell → one field value. Empty cells leave the field unset; linked records
 * match their exact primary text; everything else reads the way a paste does.
 */
export function coerceImportValue(field: ImportField, raw: string, ctx: ImportValueContext): TableCellTextResult {
  if (field.type !== 'relation') return coerceTableCellText(field, raw, ctx);
  if (!normalizeCellText(raw)) return { ok: true, value: undefined };
  return linkedRecords(field, raw.trim(), ctx);
}

// ─── Select options ───────────────────────────────────────

/** The cell's labels that are not options of `field` yet (in order, deduplicated). */
export function missingSelectLabels(field: ImportField, raw: string): string[] {
  const text = raw.trim();
  if (!text || (field.type !== 'single_select' && field.type !== 'multi_select')) return [];
  const options = field.config.options ?? [];
  return cellSelectLabels(field, text).filter((label) => !findCellOption(options, label));
}

function optionSlug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'option'
  );
}

/**
 * `options` plus one new option per label (ids unique, labels ≤ 100 characters,
 * at most 100 options in all). Labels that do not fit are left out — their
 * cells then fail like any unknown option.
 */
export function withImportedOptions(
  options: readonly TableSelectOption[],
  labels: readonly string[],
): TableSelectOption[] {
  const next = [...options];
  const ids = new Set(next.map((option) => option.id));
  for (const label of labels) {
    if (next.length >= MAX_SELECT_OPTIONS) break;
    if (label.length > MAX_OPTION_LABEL || findCellOption(next, label)) continue;
    const slug = optionSlug(label);
    let suffix = next.length + 1;
    while (ids.has(`${slug}-${suffix}`)) suffix += 1;
    const id = `${slug}-${suffix}`;
    ids.add(id);
    next.push({ id, label });
  }
  return next;
}

// ─── Columns ──────────────────────────────────────────────

const INFERENCE_SAMPLE = 500;

/**
 * The field type a new field for this column should get: number, boolean, date,
 * datetime, email, url, single select (few repeated values), long text, text.
 */
export function inferImportColumnType(values: readonly string[]): TableFieldType {
  const cells = values.map(normalizeCellText).filter(Boolean).slice(0, INFERENCE_SAMPLE);
  if (cells.length === 0) return 'text';
  const every = (test: (cell: string) => boolean) => cells.every(test);
  if (every((cell) => parseCellNumber(cell) !== null)) return 'number';
  if (every((cell) => parseCellBoolean(cell) !== null)) return 'boolean';
  const order = inferCellDateOrder(cells);
  if (every((cell) => !cellTextHasTime(cell) && parseCellDate(cell, order) !== null)) return 'date';
  if (every((cell) => parseCellDateTime(cell, 'UTC', order) !== null)) return 'datetime';
  if (every((cell) => parseCellEmail(cell) !== null)) return 'email';
  if (every((cell) => /^https?:\/\/\S+$/i.test(cell) || /^www\.\S+\.\S+$/i.test(cell))) return 'url';
  if (values.some((value) => value.length > 255 || value.includes('\n'))) return 'long_text';
  const distinct = new Set(cells);
  if (
    cells.length >= 4 &&
    distinct.size <= 12 &&
    distinct.size <= cells.length / 2 &&
    [...distinct].every((cell) => cell.length <= 40)
  ) {
    return 'single_select';
  }
  return 'text';
}

function headerKey(text: string): string {
  return text
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
}

/** The field whose name matches this header (case, width and spacing ignored), if exactly one does. */
export function matchImportHeader<T extends Pick<ImportField, 'name'>>(
  header: string,
  fields: readonly T[],
): T | undefined {
  const key = headerKey(header);
  if (!key) return undefined;
  const matches = fields.filter((field) => headerKey(field.name) === key);
  return matches.length === 1 ? matches[0] : undefined;
}
