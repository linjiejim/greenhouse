/**
 * CSV import (TBL-10): a CSV file read into one data table. The upload keeps it as a draft for a
 * day, with its first rows and a mapping from columns to fields suggested by name; starting it
 * queues the work, which writes the rows in batches as the member who imported it. A row with a
 * cell its field cannot read, or that the table refuses, is skipped and reported; the rest are
 * created.
 */

import { z } from 'zod';
import { isoTime } from './common.js';

/** A file can be up to 20 MB... */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
/** ...with up to 50,000 rows below its header... */
export const MAX_IMPORT_ROWS = 50_000;
/** ...and up to 500 columns (a table holds 200 fields: the rest are left out). */
export const MAX_IMPORT_COLUMNS = 500;
/** Skipped rows reported one by one; past these they are only counted. */
export const MAX_IMPORT_ERRORS = 100;
/** Values shown per column to recognise it. */
export const IMPORT_SAMPLES = 3;

export const IMPORT_STATUSES = ['draft', 'queued', 'running', 'done', 'failed', 'cancelled'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];
/** Still writing: its progress moves. */
export const isImportActive = (status: ImportStatus) => status === 'queued' || status === 'running';

/**
 * Why a row was skipped: a cell its field cannot read (the reasons of a paste: not a number,
 * date or date-time, no such option, member or record), a required field left empty, or a value
 * the table refused.
 */
export const IMPORT_ROW_REASONS = [
  'number',
  'date',
  'datetime',
  'option',
  'member',
  'record',
  'required',
  'invalid',
] as const;
export type ImportRowReason = (typeof IMPORT_ROW_REASONS)[number];

/** Why an import stopped before its end; the rows it wrote stay. */
export const IMPORT_FAILURES = ['no_access', 'table_gone', 'file_gone', 'fields_changed', 'stopped'] as const;
export type ImportFailure = (typeof IMPORT_FAILURES)[number];

/** Why a file cannot be imported: the error codes of the upload (`details.row` names the row). */
export const IMPORT_FILE_ERRORS = [
  'not_csv',
  'not_utf8',
  'empty_file',
  'too_large',
  'too_many_rows',
  'too_many_columns',
  'cell_too_long',
  'row_too_long',
  'unclosed_quote',
] as const;
export type ImportFileError = (typeof IMPORT_FILE_ERRORS)[number];

export const importColumnSchema = z.object({
  index: z.number().int(),
  /** The column's text in the file's first row: its header, when the first row is one. */
  first: z.string(),
  /** A few values from the rows below the first. */
  samples: z.array(z.string()),
});
export type ImportColumn = z.infer<typeof importColumnSchema>;

export const importRowErrorSchema = z.object({
  /** The row in the file, the first (the header) being row 1. */
  row: z.number().int(),
  /** The column it is about (an index into `columns`); null when it is about no one cell. */
  column: z.number().int().nullable(),
  reason: z.enum(IMPORT_ROW_REASONS),
  /** What the cell said, cut short. */
  text: z.string(),
});
export type ImportRowError = z.infer<typeof importRowErrorSchema>;

export const importResultSchema = z.object({
  created: z.number().int(),
  skipped: z.number().int(),
  /** The first MAX_IMPORT_ERRORS skipped rows. */
  errors: z.array(importRowErrorSchema),
  /** Skipped rows past those. */
  more_errors: z.number().int(),
});
export type ImportResult = z.infer<typeof importResultSchema>;

export const baseImportSchema = z.object({
  id: z.string(),
  base_id: z.string(),
  table_id: z.string(),
  file_name: z.string(),
  status: z.enum(IMPORT_STATUSES),
  /** The first row is the header: it names the columns and is not imported. */
  header: z.boolean(),
  columns: z.array(importColumnSchema),
  /** The field each column goes into, one entry per column; null: not imported. */
  mapping: z.array(z.string().nullable()),
  /** Rows to import (blank rows and the header do not count). */
  total_rows: z.number().int(),
  /** Rows written or skipped so far. */
  committed_rows: z.number().int(),
  result: importResultSchema,
  /** Why a failed import stopped. */
  failure: z.enum(IMPORT_FAILURES).nullable(),
  /** A draft waits until then; null once started. */
  expires_at: isoTime.nullable(),
  created_at: isoTime,
  updated_at: isoTime,
});
export type BaseImport = z.infer<typeof baseImportSchema>;

/** A draft's choices: where each column goes (one entry per column) and whether the first row is the header. */
export const updateImportInputSchema = z.object({
  header: z.boolean().optional(),
  mapping: z.array(z.string().min(1).max(64).nullable()).max(MAX_IMPORT_COLUMNS).optional(),
});
export type UpdateImportInput = z.infer<typeof updateImportInputSchema>;
