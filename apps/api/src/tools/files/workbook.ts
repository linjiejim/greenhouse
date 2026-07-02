/**
 * Workbook builders — turn a neutral {columns, rows} table spec into CSV or XLSX
 * bytes. Pure and side-effect free (no storage, no env) so it unit-tests cleanly;
 * the export_table tool wires these to storage.
 */

import ExcelJS from 'exceljs';

export type CellValue = string | number | boolean | null;

export interface SheetSpec {
  name: string;
  columns: string[];
  rows: CellValue[][];
}

// Caps — model-authored data is untrusted for SIZE (token budget aside, a runaway
// call shouldn't exhaust memory). Generous enough for real analysis exports.
export const LIMITS = { sheets: 20, cols: 100, rows: 50_000 } as const;

/** Validate a sheet set against the caps. Throws a message safe to show the model. */
export function validateSheets(sheets: SheetSpec[]): void {
  if (!sheets.length) throw new Error('At least one sheet is required.');
  if (sheets.length > LIMITS.sheets) throw new Error(`Too many sheets (max ${LIMITS.sheets}).`);
  for (const s of sheets) {
    if (!s.columns?.length) throw new Error(`Sheet "${s.name}" has no columns.`);
    if (s.columns.length > LIMITS.cols) throw new Error(`Sheet "${s.name}" exceeds ${LIMITS.cols} columns.`);
    if (s.rows.length > LIMITS.rows) throw new Error(`Sheet "${s.name}" exceeds ${LIMITS.rows} rows.`);
  }
}

/** Pad/truncate a row to exactly `width` cells (models occasionally miscount). */
function fitRow(row: CellValue[], width: number): CellValue[] {
  if (row.length === width) return row;
  if (row.length > width) return row.slice(0, width);
  return [...row, ...Array<CellValue>(width - row.length).fill(null)];
}

// ─── CSV ─────────────────────────────────────────────────

function csvCell(v: CellValue): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build a UTF-8 CSV (single table). Prepends a BOM so Excel opens non-ASCII
 * (e.g. Chinese) content without mojibake; uses CRLF line endings for Excel.
 */
export function buildCsv(sheet: SheetSpec): Buffer {
  const width = sheet.columns.length;
  const lines = [sheet.columns.map(csvCell).join(',')];
  for (const row of sheet.rows) lines.push(fitRow(row, width).map(csvCell).join(','));
  const BOM = Buffer.from('﻿', 'utf8'); // UTF-8 BOM → Excel reads UTF-8 correctly
  return Buffer.concat([BOM, Buffer.from(lines.join('\r\n'), 'utf8')]);
}

// ─── XLSX ────────────────────────────────────────────────

/** Excel sheet names: ≤31 chars, none of []:*?/\, non-empty, unique in a workbook. */
function uniqueSheetName(raw: string, used: Set<string>): string {
  const base =
    (raw || 'Sheet')
      .replace(/[[\]:*?/\\]/g, ' ')
      .trim()
      .slice(0, 31) || 'Sheet';
  let name = base;
  let n = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` (${n++})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

/** Build an .xlsx workbook — one worksheet per sheet, bold + frozen header row. */
export async function buildXlsx(sheets: SheetSpec[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const used = new Set<string>();
  for (const s of sheets) {
    const ws = wb.addWorksheet(uniqueSheetName(s.name, used));
    const width = s.columns.length;
    ws.addRow(s.columns);
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const row of s.rows) ws.addRow(fitRow(row, width));
    ws.columns.forEach((col, i) => {
      col.width = Math.min(60, Math.max(10, (s.columns[i]?.length ?? 8) + 2));
    });
  }
  // exceljs types writeBuffer as its own Buffer-like; normalize to a Node Buffer.
  return Buffer.from(await wb.xlsx.writeBuffer());
}
