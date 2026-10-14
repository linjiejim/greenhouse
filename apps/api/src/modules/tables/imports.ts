/**
 * CSV import (TBL-10). An editor uploads a CSV file for a data table: it is read once (its first
 * row, a few sample values, how many rows) and kept as a draft for a day, each column mapped to
 * the writable field of the same name. Starting it queues a `base_import` job, which writes the
 * rows in batches as the importer, who must still be able to edit the table. Each batch is one
 * transaction that creates its records and moves `committed_rows`, so a retry continues after
 * the rows already written and never writes one twice. A row with a cell its field cannot read,
 * or that the table refuses, is skipped and reported. A job writes for a slice of time, then
 * hands the rest to a new job, so the other work of the tables queue is not held up.
 * An import is its importer's: anyone else's is not found.
 */

import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  CellParseError,
  IMPORT_FAILURES,
  IMPORT_ROW_REASONS,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ERRORS,
  MAX_IMPORT_ROWS,
  isComputedType,
  isEmptyValue,
  isImportActive,
  isLinkType,
  linkTarget,
  parseCell,
  type BaseImport,
  type CellContext,
  type Field,
  type ImportFailure,
  type ImportRowError,
  type ImportRowReason,
  type Page,
  type RecordValues,
  type UpdateImportInput,
} from '@greenhouse/contract';
import {
  baseImports,
  baseRecords,
  baseTables,
  bases,
  files,
  getDb,
  jobs,
  members,
  newId,
  transaction,
  type BaseFieldRow,
  type BaseImportRow,
  type BaseRecordRow,
  type JobRow,
} from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { ApiError, conflict, invalidInput, notFound } from '../../http/errors.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';
import { enqueueJob, type JobOutcome } from '../../jobs.js';
import { loadReader, needsRole, type TablesReader } from './access.js';
import { CsvError, dataRows, decodeCsv, scanCsv, type CsvRow } from './imports-csv.js';
import type { TablesKit } from './kit.js';
import { tableAt, toField, type TableAt } from './load.js';
import { recordsWhere } from './query.js';
import { scopeOf, type TableScope } from './scope.js';

/** Rows written in one transaction. */
const BATCH = 100;
/** How long one job writes before it hands the rest to a new one. */
const SLICE_MS = 30_000;
const DRAFT_HOURS = 24;
/** Finished imports are kept this long for their report. */
const KEEP_DAYS = 30;
/**
 * A queued or running import touches its row with every batch and every try of its job; one
 * quiet for this long is looked at for a job that will still run it.
 */
const QUIET_MINUTES = 60;
/** Characters of a cell kept in a report. */
const SHOWN = 100;

const ACTIVE = ['queued', 'running'] as const;
const OPEN = ['draft', 'queued', 'running'] as const;
const FINISHED = ['done', 'failed', 'cancelled'] as const;

export const tooLarge = () => new ApiError(413, 'too_large', 'CSV files can be up to 20 MB.');

/** What each refusal of a file says; `details.row` names the row. */
const FILE_PROBLEMS: Record<CsvError['code'], string> = {
  not_csv: 'This is not a CSV text file.',
  not_utf8: 'The file is not UTF-8. Save it as CSV UTF-8 and upload it again.',
  empty_file: 'The file has no rows.',
  too_many_rows: `A file can have up to ${MAX_IMPORT_ROWS} rows below its header.`,
  too_many_columns: `A file can have up to ${MAX_IMPORT_COLUMNS} columns.`,
  cell_too_long: 'A cell is too long.',
  row_too_long: 'A row is too long.',
  unclosed_quote: 'A quote is never closed.',
};

/** What base_imports.mapping holds: the choices, and the file's first rows to make them against. */
type Stored = {
  header: boolean;
  /** The field each column goes into (null: not imported), one entry per column. */
  columns: Array<string | null>;
  first: string[];
  samples: string[][];
};

/** What base_imports.result holds: the counts and reported rows so far, and why it failed. */
type Stats = {
  created: number;
  skipped: number;
  errors: ImportRowError[];
  more_errors: number;
  failure?: ImportFailure;
};

/** A mapped column against the field it goes into now. */
interface Column {
  index: number;
  field: BaseFieldRow;
  shape: Field;
}

/** The importer as a running import checks them: still active, still an editor of the table. */
interface Importer {
  reader: TablesReader;
  at: TableAt;
  scope: TableScope;
}

/** How cells find what they name, looked up once per job: members, and linked records by title per table. */
interface Lookups {
  cell: CellContext;
  titles: Map<string, Map<string, string>>;
}

const texts = (value: unknown) => (Array.isArray(value) ? value.map((entry) => String(entry ?? '')) : []);
const count = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);
const shown = (text: string) => (text.length > SHOWN ? `${text.slice(0, SHOWN)}…` : text);
const failureOf = (value: unknown) =>
  (IMPORT_FAILURES as readonly unknown[]).includes(value) ? (value as ImportFailure) : undefined;

function storedOf(row: Pick<BaseImportRow, 'mapping'>): Stored {
  const value = row.mapping as Partial<Record<keyof Stored, unknown>>;
  const first = texts(value.first);
  const columns = Array.isArray(value.columns) ? value.columns : [];
  const samples = Array.isArray(value.samples) ? value.samples : [];
  return {
    header: value.header !== false,
    first,
    columns: first.map((_, index) => (typeof columns[index] === 'string' ? (columns[index] as string) : null)),
    samples: first.map((_, index) => texts(samples[index])),
  };
}

function statsOf(row: Pick<BaseImportRow, 'result'>): Stats {
  const value = row.result as Partial<Record<keyof Stats, unknown>>;
  const failure = failureOf(value.failure);
  return {
    created: count(value.created),
    skipped: count(value.skipped),
    errors: Array.isArray(value.errors) ? (value.errors as ImportRowError[]) : [],
    more_errors: count(value.more_errors),
    ...(failure ? { failure } : {}),
  };
}

function view(row: BaseImportRow, fileName: string | null): BaseImport {
  const stored = storedOf(row);
  const stats = statsOf(row);
  return {
    id: row.id,
    base_id: row.baseId,
    table_id: row.tableId,
    file_name: fileName ?? '',
    status: row.status,
    header: stored.header,
    columns: stored.first.map((first, index) => ({ index, first, samples: stored.samples[index] ?? [] })),
    mapping: stored.columns,
    total_rows: row.totalRows,
    committed_rows: row.committedRows,
    result: { created: stats.created, skipped: stats.skipped, errors: stats.errors, more_errors: stats.more_errors },
    failure: stats.failure ?? null,
    expires_at: row.status === 'draft' ? row.expiresAt : null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/** Fields an import may write: those the importer sees, but computed ones and attachments. */
const writable = (fields: readonly BaseFieldRow[]) =>
  fields.filter((field) => !isComputedType(field.type) && field.type !== 'attachment');

/** Each column into the writable field of the same name (case and spaces aside), each field once. */
function suggest(names: readonly string[], fields: readonly BaseFieldRow[]): Array<string | null> {
  const byName = new Map<string, string>();
  for (const field of writable(fields)) {
    const key = field.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, field.id);
  }
  const used = new Set<string>();
  return names.map((name) => {
    const id = byName.get(name.trim().toLowerCase());
    if (!id || used.has(id)) return null;
    used.add(id);
    return id;
  });
}

/** The mapped columns against the fields now; null when a mapped field is gone or cannot be written. */
function planOf(stored: Stored, scope: TableScope): Column[] | null {
  const byId = new Map(writable(scope.fields).map((field) => [field.id, field]));
  const columns: Column[] = [];
  for (const [index, fieldId] of stored.columns.entries()) {
    if (!fieldId) continue;
    const field = byId.get(fieldId);
    if (!field) return null;
    columns.push({ index, field, shape: toField(field) });
  }
  return columns;
}

/** The reasons of a paste, but attachments (never mapped) and anything else the table refused. */
const rowReason = (reason: CellParseError['reason']): ImportRowReason =>
  (IMPORT_ROW_REASONS as readonly string[]).includes(reason) ? (reason as ImportRowReason) : 'invalid';

const draftOnly = (row: BaseImportRow) => {
  if (row.status !== 'draft') throw conflict('import_started', 'This import has already started.');
  if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) {
    throw conflict('import_expired', 'This import has expired. Upload the file again.');
  }
};

const quiet = (row: BaseImportRow) =>
  isImportActive(row.status) && Date.parse(row.updatedAt) < Date.now() - QUIET_MINUTES * 60_000;

/**
 * Queued or running imports quiet for an hour that no job waits for or runs any more: their job
 * died with its process, or the queue gave up on it.
 */
const jobless = and(
  inArray(baseImports.status, ['queued', 'running']),
  sql`${baseImports.updatedAt} < now() - make_interval(mins => ${QUIET_MINUTES}::int)`,
  sql`NOT EXISTS (SELECT 1 FROM ${jobs} WHERE ${jobs.kind} = 'base_import' AND ${jobs.status} IN ('pending', 'claimed') AND ${jobs.payload} ->> 'import_id' = ${baseImports.id})`,
);

export function createImports(kit: TablesKit, options: { sliceMs?: number } = {}) {
  const sliceMs = options.sliceMs ?? SLICE_MS;

  /** Imports with the name of their file. */
  const withFile = (where: SQL | undefined) =>
    getDb()
      .select({ row: baseImports, fileName: files.name })
      .from(baseImports)
      .leftJoin(files, eq(files.id, baseImports.fileId))
      .where(where);

  /** The member may write records into the table: an editor (a custom role that edits it). */
  async function editorOf(memberId: string, tableId: string) {
    const reader = await loadReader(memberId);
    const at = await tableAt(reader, tableId, 'editor');
    const scope = await scopeOf(reader, at);
    if (!scope.canEdit) throw needsRole('editor');
    return { reader, at, scope };
  }

  /** One of the member's own imports, with their access to its table now; anyone else's is not found. */
  async function reach(memberId: string, importId: string, needed: 'viewer' | 'editor') {
    const [found] = await withFile(eq(baseImports.id, importId));
    if (!found || found.row.memberId !== memberId) throw notFound('Import');
    const reader = await loadReader(memberId);
    let at: TableAt;
    try {
      at = await tableAt(reader, found.row.tableId, needed);
    } catch (error) {
      // The table, or the member's way to it, is gone: so is the import, for them.
      if (error instanceof ApiError && error.status === 404) throw notFound('Import');
      throw error;
    }
    const scope = await scopeOf(reader, at);
    if (needed === 'editor' && !scope.canEdit) throw needsRole('editor');
    return { ...found, reader, at, scope };
  }

  async function discardFile(fileId: string | null) {
    if (!fileId) return;
    await kit.files
      .discard(fileId)
      .catch((error: unknown) =>
        logger.warn('[tables] could not delete an import file', { file: fileId, error: toErrorMessage(error) }),
      );
  }

  /** Stops the imports that cannot go on: the rows they wrote stay, their files go. */
  async function failWhere(where: SQL | undefined, failure: ImportFailure): Promise<BaseImportRow[]> {
    const stopped = await getDb()
      .update(baseImports)
      .set({
        status: 'failed',
        result: sql`${baseImports.result} || jsonb_build_object('failure', ${failure}::text)`,
        updatedAt: sql`now()`,
      })
      .where(and(inArray(baseImports.status, [...ACTIVE]), where))
      .returning();
    for (const row of stopped) await discardFile(row.fileId);
    return stopped;
  }

  const fail = async (row: Pick<BaseImportRow, 'id'>, failure: ImportFailure) =>
    (await failWhere(eq(baseImports.id, row.id), failure))[0] ?? null;

  /** An import read while quiet for an hour: failed when no job will run it any more. */
  async function settled(row: BaseImportRow): Promise<BaseImportRow> {
    if (!quiet(row)) return row;
    return (await failWhere(and(eq(baseImports.id, row.id), jobless), 'stopped'))[0] ?? row;
  }

  // ── The job ──────────────────────────────────────────

  /** Whether the data table and its base are still there (not deleted, not in the recycle bin). */
  async function tableLive(tableId: string) {
    const [found] = await getDb()
      .select({ id: baseTables.id })
      .from(baseTables)
      .innerJoin(bases, eq(bases.id, baseTables.baseId))
      .where(and(eq(baseTables.id, tableId), isNull(baseTables.archivedAt), isNull(bases.archivedAt)));
    return !!found;
  }

  /** The importer, checked before every batch; why the import cannot go on, when it cannot. */
  async function importer(row: Pick<BaseImportRow, 'memberId' | 'tableId'>): Promise<Importer | ImportFailure> {
    const [member] = await getDb().select({ status: members.status }).from(members).where(eq(members.id, row.memberId));
    if (member?.status !== 'active') return 'no_access';
    try {
      return await editorOf(row.memberId, row.tableId);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status >= 500) throw error;
      return error.status === 404 && !(await tableLive(row.tableId)) ? 'table_gone' : 'no_access';
    }
  }

  /** The file's text again; null when it is gone. */
  async function fileText(row: BaseImportRow): Promise<string | null> {
    if (!row.fileId) return null;
    try {
      const { bytes } = await kit.files.bytes(row.memberId, row.fileId);
      return decodeCsv(bytes);
    } catch (error) {
      if (error instanceof CsvError || (error instanceof ApiError && error.status === 404)) return null;
      throw error;
    }
  }

  /** A table's records by title (lower case; the oldest of a title), as the importer sees them. */
  async function titlesIn(who: Importer, tableId: string): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    let scope = who.scope;
    if (tableId !== who.at.table.id) {
      try {
        scope = await scopeOf(who.reader, await tableAt(who.reader, tableId, 'viewer'));
      } catch (error) {
        if (error instanceof ApiError && error.status < 500) return found;
        throw error;
      }
    }
    const primary = scope.fields.find((field) => field.isPrimary);
    if (!primary) return found;
    const rows = await getDb()
      .select({ id: baseRecords.id, title: sql<string | null>`${baseRecords.values} ->> ${primary.id}` })
      .from(baseRecords)
      .where(recordsWhere(tableId, scope.rows))
      .orderBy(asc(baseRecords.seq));
    for (const row of rows) {
      const key = row.title?.trim().toLowerCase();
      if (key && !found.has(key)) found.set(key, row.id);
    }
    return found;
  }

  async function lookups(who: Importer, columns: readonly Column[]): Promise<Lookups> {
    const people = new Map<string, string | null>();
    if (columns.some((column) => column.field.type === 'member')) {
      const rows = await getDb()
        .select({ id: members.id, name: members.name, email: members.email })
        .from(members)
        .where(eq(members.status, 'active'));
      for (const row of rows) {
        for (const key of new Set([row.name.trim().toLowerCase(), row.email.trim().toLowerCase()])) {
          // A name two members share finds neither: an import never guesses who was meant.
          if (key) people.set(key, people.has(key) && people.get(key) !== row.id ? null : row.id);
        }
      }
    }
    const titles = new Map<string, Map<string, string>>();
    for (const column of columns) {
      if (!isLinkType(column.field.type)) continue;
      const tableId = linkTarget(column.shape);
      if (tableId && !titles.has(tableId)) titles.set(tableId, await titlesIn(who, tableId));
    }
    return {
      titles,
      cell: {
        timeZone: who.reader.timeZone,
        findMember: (text) => people.get(text.trim().toLowerCase()) ?? undefined,
        findRecord: (tableId, title) => titles.get(tableId)?.get(title.trim().toLowerCase()),
      },
    };
  }

  /** One row: its cells read as their fields, then the record written as the importer (in a savepoint). */
  async function writeRow(
    who: Importer,
    columns: readonly Column[],
    found: Lookups,
    line: CsvRow,
    importId: string,
  ): Promise<{ record: BaseRecordRow } | { error: ImportRowError }> {
    const values: RecordValues = {};
    for (const column of columns) {
      try {
        values[column.field.id] = parseCell(column.shape, line.cells[column.index] ?? '', found.cell);
      } catch (error) {
        if (!(error instanceof CellParseError)) throw error;
        return {
          error: { row: line.number, column: column.index, reason: rowReason(error.reason), text: shown(error.text) },
        };
      }
    }
    for (const field of who.scope.fields) {
      if (!field.required || isComputedType(field.type) || !isEmptyValue(values[field.id])) continue;
      const column = columns.find((entry) => entry.field.id === field.id);
      return { error: { row: line.number, column: column?.index ?? null, reason: 'required', text: '' } };
    }
    try {
      const record = await transaction(() =>
        kit.records.insertFrom(who.at, who.reader, values, { type: 'import', id: importId }),
      );
      // A later row may name this one in a parent, dependency or relation to its own table.
      const primary = who.scope.fields.find((field) => field.isPrimary);
      const title = primary ? values[primary.id] : undefined;
      const own = found.titles.get(who.at.table.id);
      const key = typeof title === 'string' ? title.trim().toLowerCase() : '';
      if (own && key && !own.has(key)) own.set(key, record.id);
      return { record };
    } catch (error) {
      // The table refused the row (a value it does not take, a link it cannot make): that row only.
      if (!(error instanceof ApiError) || error.status >= 500) throw error;
      const fieldId = (error.details as { field?: unknown } | undefined)?.field;
      const column = columns.find((entry) => entry.field.id === fieldId);
      return {
        error: {
          row: line.number,
          column: column?.index ?? null,
          reason: 'invalid',
          text: column ? shown((line.cells[column.index] ?? '').trim()) : '',
        },
      };
    }
  }

  /** Writes batches from `committed_rows` until the slice is over, then hands the rest to a new job. */
  async function slice(start: BaseImportRow): Promise<JobOutcome> {
    const deadline = Date.now() + sliceMs;
    let who = await importer(start);
    if (typeof who === 'string') {
      await fail(start, who);
      return { status: 'succeeded', result: { failure: who } };
    }
    const text = await fileText(start);
    if (text === null) {
      await fail(start, 'file_gone');
      return { status: 'succeeded', result: { failure: 'file_gone' } };
    }
    const [row] = await getDb()
      .update(baseImports)
      .set({ status: 'running', updatedAt: sql`now()` })
      .where(and(eq(baseImports.id, start.id), inArray(baseImports.status, [...ACTIVE])))
      .returning();
    // Cancelled meanwhile.
    if (!row) return { status: 'succeeded' };
    const stored = storedOf(row);
    let columns = planOf(stored, who.scope);
    if (!columns) {
      await fail(row, 'fields_changed');
      return { status: 'succeeded', result: { failure: 'fields_changed' } };
    }
    const found = await lookups(who, columns);

    const rows = dataRows(text, stored.header);
    // Rows that earlier jobs, or an earlier try of this one, already wrote or skipped.
    for (let passed = 0; passed < row.committedRows; passed++) if (rows.next().done) break;
    let ahead: CsvRow | null = null;
    const take = () => {
      const batch: CsvRow[] = ahead ? [ahead] : [];
      ahead = null;
      while (batch.length < BATCH) {
        const next = rows.next();
        if (next.done) return { batch, more: false };
        batch.push(next.value);
      }
      const next = rows.next();
      if (next.done) return { batch, more: false };
      ahead = next.value;
      return { batch, more: true };
    };

    let committed = row.committedRows;
    for (let first = true; ; first = false) {
      if (!first) {
        who = await importer(row);
        if (typeof who === 'string') {
          await fail(row, who);
          return { status: 'succeeded', result: { failure: who } };
        }
        columns = planOf(stored, who.scope);
        if (!columns) {
          await fail(row, 'fields_changed');
          return { status: 'succeeded', result: { failure: 'fields_changed' } };
        }
      }
      const writer = who;
      const plan = columns;
      const { batch, more } = take();
      const from = committed;
      const outcome = await transaction(async () => {
        const [locked] = await getDb().select().from(baseImports).where(eq(baseImports.id, row.id)).for('update');
        // Cancelled, or another run of this import already wrote these rows: this one stops.
        if (!locked || locked.status !== 'running' || locked.committedRows !== from) return null;
        const stats = statsOf(locked);
        const created: BaseRecordRow[] = [];
        for (const line of batch) {
          const written = await writeRow(writer, plan, found, line, row.id);
          if ('record' in written) {
            created.push(written.record);
            stats.created++;
            continue;
          }
          stats.skipped++;
          if (stats.errors.length < MAX_IMPORT_ERRORS) stats.errors.push(written.error);
          else stats.more_errors++;
        }
        const next = from + batch.length;
        const handOff = more && Date.now() >= deadline;
        await getDb()
          .update(baseImports)
          .set({
            committedRows: next,
            result: stats,
            ...(more ? {} : { status: 'done' as const }),
            updatedAt: sql`now()`,
          })
          .where(eq(baseImports.id, row.id));
        if (handOff) {
          await enqueueJob({
            kind: 'base_import',
            dedupeKey: `base_import:${row.id}:${next}`,
            payload: { import_id: row.id },
          });
        }
        return { created, next, handOff };
      });
      if (!outcome) return { status: 'succeeded' };
      committed = outcome.next;
      try {
        await kit.records.announce(writer.at, outcome.created);
      } catch (error) {
        logger.warn('[tables] could not tell about imported records', { import: row.id, error: toErrorMessage(error) });
      }
      if (!more) {
        await discardFile(row.fileId);
        return { status: 'succeeded', result: { rows: committed } };
      }
      if (outcome.handOff) {
        kit.worker.kick();
        return { status: 'succeeded', result: { rows: committed, continued: true } };
      }
    }
  }

  async function run(job: JobRow): Promise<JobOutcome> {
    const importId = typeof job.payload.import_id === 'string' ? job.payload.import_id : '';
    const [row] = await getDb().select().from(baseImports).where(eq(baseImports.id, importId));
    // Cancelled, finished or deleted meanwhile: nothing is left to do.
    if (!row || !isImportActive(row.status)) return { status: 'succeeded' };
    try {
      return await slice(row);
    } catch (error) {
      // Not a row's fault (the database, the storage): the queue tries again later, from the rows
      // already committed. When it has tried enough, the import fails with the job.
      const message = toErrorMessage(error).slice(0, 500);
      logger.warn('[tables] an import stopped partway', { import: row.id, attempt: job.attempts, error: message });
      if (job.attempts >= job.maxAttempts) await fail(row, 'stopped');
      else {
        await getDb()
          .update(baseImports)
          .set({ status: 'queued', updatedAt: sql`now()` })
          .where(and(eq(baseImports.id, row.id), eq(baseImports.status, 'running')));
      }
      return { status: 'retry', error: message };
    }
  }

  kit.worker.register('base_import', run);

  return {
    /** Refuses before the upload is read: only editors of the table import into it. */
    async canImport(memberId: string, tableId: string): Promise<void> {
      await editorOf(memberId, tableId);
    },

    /** Reads a CSV file and keeps it as a draft for a day, its columns mapped to fields by name. */
    async upload(memberId: string, tableId: string, file: { name: string; bytes: Uint8Array }): Promise<BaseImport> {
      const { at, scope } = await editorOf(memberId, tableId);
      if (file.bytes.byteLength > MAX_IMPORT_BYTES) throw tooLarge();
      let summary: ReturnType<typeof scanCsv>;
      try {
        summary = scanCsv(decodeCsv(file.bytes));
      } catch (error) {
        if (!(error instanceof CsvError)) throw error;
        throw new ApiError(400, error.code, FILE_PROBLEMS[error.code], error.row ? { row: error.row } : undefined);
      }
      const stored = await kit.files.store(memberId, {
        name: file.name,
        contentType: 'text/csv',
        bytes: file.bytes,
        purpose: 'import',
        baseId: at.base.id,
      });
      try {
        const mapping: Stored = {
          header: true,
          columns: suggest(summary.first, scope.fields),
          first: summary.first,
          samples: summary.samples,
        };
        const [row] = await getDb()
          .insert(baseImports)
          .values({
            id: newId('baseImport'),
            baseId: at.base.id,
            tableId,
            memberId,
            fileId: stored.id,
            mapping,
            status: 'draft',
            totalRows: summary.rows - 1,
            expiresAt: sql`now() + make_interval(hours => ${DRAFT_HOURS}::int)`,
          })
          .returning();
        return view(row!, stored.name);
      } catch (error) {
        await discardFile(stored.id);
        throw error;
      }
    },

    /** My imports into a data table, newest first. */
    async list(
      memberId: string,
      tableId: string,
      query: { cursor?: string | undefined; limit: number },
    ): Promise<Page<BaseImport>> {
      const reader = await loadReader(memberId);
      await tableAt(reader, tableId, 'viewer');
      const before = decodeCursor(query.cursor);
      const rows = await withFile(
        and(
          eq(baseImports.tableId, tableId),
          eq(baseImports.memberId, memberId),
          before ? lt(baseImports.id, before) : undefined,
        ),
      )
        .orderBy(desc(baseImports.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const items: BaseImport[] = [];
      for (const entry of page) items.push(view(await settled(entry.row), entry.fileName));
      return {
        items,
        next_cursor: rows.length > query.limit ? encodeCursor(page[page.length - 1]!.row.id) : null,
      };
    },

    /** One of my imports: its mapping, how far it got and what it skipped. */
    async get(memberId: string, importId: string): Promise<BaseImport> {
      const { row, fileName } = await reach(memberId, importId, 'viewer');
      return view(await settled(row), fileName);
    },

    /** A draft's mapping (each column into a field the importer may write, each field once) and header. */
    async update(memberId: string, importId: string, input: UpdateImportInput): Promise<BaseImport> {
      const { row, fileName, scope } = await reach(memberId, importId, 'editor');
      draftOnly(row);
      if (input.mapping) {
        if (input.mapping.length !== storedOf(row).first.length) {
          throw invalidInput('Give one entry for every column of the file.');
        }
        const allowed = new Set(writable(scope.fields).map((field) => field.id));
        const seen = new Set<string>();
        for (const fieldId of input.mapping) {
          if (!fieldId) continue;
          if (!allowed.has(fieldId))
            throw invalidInput('A column goes into a field it cannot be imported into.', { field: fieldId });
          if (seen.has(fieldId)) throw invalidInput('Two columns go into the same field.', { field: fieldId });
          seen.add(fieldId);
        }
      }
      const saved = await transaction(async () => {
        const [locked] = await getDb().select().from(baseImports).where(eq(baseImports.id, row.id)).for('update');
        if (locked?.status !== 'draft') throw conflict('import_started', 'This import has already started.');
        const before = storedOf(locked);
        const next: Stored = {
          ...before,
          ...(input.mapping ? { columns: input.mapping } : {}),
          ...(input.header !== undefined ? { header: input.header } : {}),
        };
        // The first row is a record when it is not the header.
        const total = locked.totalRows + (before.header ? 1 : 0) - (next.header ? 1 : 0);
        const [updated] = await getDb()
          .update(baseImports)
          .set({ mapping: next, totalRows: total, updatedAt: sql`now()` })
          .where(eq(baseImports.id, row.id))
          .returning();
        return updated!;
      });
      return view(saved, fileName);
    },

    /** Queues a draft. Every mapped field must still be writable, and every required field mapped. */
    async start(memberId: string, importId: string): Promise<BaseImport> {
      const { row, fileName, scope } = await reach(memberId, importId, 'editor');
      draftOnly(row);
      const columns = planOf(storedOf(row), scope);
      if (!columns) throw conflict('fields_changed', 'Some fields this import goes into are gone. Choose them again.');
      if (!columns.length) throw new ApiError(400, 'nothing_mapped', 'Choose at least one column to import.');
      const mapped = new Set(columns.map((column) => column.field.id));
      const missing = scope.fields.filter(
        (field) => field.required && !isComputedType(field.type) && !mapped.has(field.id),
      );
      if (missing.length) {
        throw new ApiError(400, 'required_unmapped', 'Some required fields have no column.', {
          fields: missing.map((field) => field.name),
        });
      }
      const started = await transaction(async () => {
        const [queued] = await getDb()
          .update(baseImports)
          .set({ status: 'queued', expiresAt: null, updatedAt: sql`now()` })
          .where(and(eq(baseImports.id, row.id), eq(baseImports.status, 'draft')))
          .returning();
        if (!queued) throw conflict('import_started', 'This import has already started.');
        await enqueueJob({ kind: 'base_import', dedupeKey: `base_import:${row.id}:0`, payload: { import_id: row.id } });
        return queued;
      });
      kit.worker.kick();
      return view(started, fileName);
    },

    /** Stops an import at its next batch (a draft at once); the rows written stay. */
    async cancel(memberId: string, importId: string): Promise<BaseImport> {
      const { row, fileName } = await reach(memberId, importId, 'viewer');
      const [stopped] = await getDb()
        .update(baseImports)
        .set({ status: 'cancelled', updatedAt: sql`now()` })
        .where(and(eq(baseImports.id, row.id), inArray(baseImports.status, [...OPEN])))
        .returning();
      if (!stopped) throw conflict('import_finished', 'This import has already finished.');
      await discardFile(stopped.fileId);
      return view(stopped, fileName);
    },

    /**
     * Daily: imports whose job died with its process fail; drafts past their day and imports
     * finished more than KEEP_DAYS ago are deleted with their files; import files no import
     * holds any more (their table or base was deleted) are deleted.
     */
    async purgeExpired(): Promise<{ deleted: number; failed: number; files: number }> {
      const stopped = await failWhere(jobless, 'stopped');
      const deleted = await getDb()
        .delete(baseImports)
        .where(
          or(
            and(eq(baseImports.status, 'draft'), lt(baseImports.expiresAt, sql`now()`)),
            and(
              inArray(baseImports.status, [...FINISHED]),
              lt(baseImports.updatedAt, sql`now() - make_interval(days => ${KEEP_DAYS}::int)`),
            ),
          ),
        )
        .returning({ fileId: baseImports.fileId });
      for (const row of deleted) await discardFile(row.fileId);
      const orphans = await getDb()
        .select({ id: files.id })
        .from(files)
        .where(
          and(
            eq(files.purpose, 'import'),
            eq(files.status, 'active'),
            lt(files.createdAt, sql`now() - interval '1 day'`),
            sql`NOT EXISTS (SELECT 1 FROM ${baseImports} WHERE ${baseImports.fileId} = ${files.id})`,
          ),
        )
        .limit(1000);
      for (const file of orphans) await discardFile(file.id);
      return { deleted: deleted.length, failed: stopped.length, files: orphans.length };
    },
  };
}

export type ImportsPart = ReturnType<typeof createImports>;
