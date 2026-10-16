/**
 * CSV export (TBL-12) of a view (its filter, sorts, group and visible fields) or of a whole data
 * table, as the reader sees it: a custom role's hidden fields and records stay out. The matching
 * ids are taken once, in order (at most MAX_EXPORT_ROWS), then written batch by batch as a
 * stream, up to MAX_EXPORT_BYTES. Text a spreadsheet would run as a formula is kept as text
 * (csvLine); numbers are written as they are.
 */

import { asc } from 'drizzle-orm';
import { csvLine, formatCell, valueTypeOf, type CsvCell, type ViewConfig } from '@greenhouse/contract';
import { baseRecords, getDb, type BaseFieldRow, type BaseRecordRow } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { notFound } from '../../http/errors.js';
import { exportFilename } from '../conversations/export.js';
import type { FilesService } from '../files/service.js';
import { memberNames } from '../knowledge/views.js';
import { loadReader } from './access.js';
import { configOf, fill, tableAt, toField, viewAt, viewerOf } from './load.js';
import { compileFilter, compileOrder, inIds, recordsWhere, type QueryContext } from './query.js';
import { scopeOf } from './scope.js';

/** Most records one export holds. */
export const MAX_EXPORT_ROWS = 50_000;
/** Most bytes one export writes; past it the file ends. */
export const MAX_EXPORT_BYTES = 100 * 1024 * 1024;
const BATCH = 500;

const isNumberValued = (field: BaseFieldRow) =>
  valueTypeOf({ type: field.type, config: { result: field.config.result } }) === 'number';

export async function exportCsv(
  deps: { files: Pick<FilesService, 'signedUrl'> },
  memberId: string,
  tableId: string,
  viewId?: string,
): Promise<{ filename: string; body: ReadableStream<Uint8Array> }> {
  const reader = await loadReader(memberId);
  const at = await tableAt(reader, tableId, 'viewer');
  const scope = await scopeOf(reader, at);
  let config: ViewConfig = {};
  if (viewId) {
    const found = await viewAt(reader, viewId);
    if (found.table?.id !== tableId) throw notFound('View');
    config = configOf(found.view);
  }
  const hidden = new Set(config.hidden ?? []);
  const order = new Map((config.order ?? []).map((id, index) => [id, index]));
  const shown = scope.fields
    .filter((field) => field.isPrimary || !hidden.has(field.id))
    .sort((a, b) =>
      a.isPrimary !== b.isPrimary ? (a.isPrimary ? -1 : 1) : (order.get(a.id) ?? 1e6) - (order.get(b.id) ?? 1e6),
    );
  const ctx: QueryContext = {
    fields: new Map(scope.fields.map((field) => [field.id, field])),
    memberId,
    timeZone: reader.timeZone,
  };
  const where = recordsWhere(tableId, scope.rows, compileFilter(config.filter, ctx));
  // The order is fixed now: later pages are these ids, so a change meanwhile moves nothing.
  const ids = (
    await getDb()
      .select({ id: baseRecords.id })
      .from(baseRecords)
      .where(where)
      .orderBy(...compileOrder(config.sorts, config.group, ctx))
      .limit(MAX_EXPORT_ROWS)
  ).map((row) => row.id);
  const viewer = viewerOf(reader, at);
  const fields = shown.map((field) => ({ row: field, view: toField(field), number: isNumberValued(field) }));
  const encoder = new TextEncoder();
  let index = 0;
  let bytes = 0;
  let started = false;

  async function lines(batch: readonly string[]): Promise<string> {
    const rows = await getDb()
      .select()
      .from(baseRecords)
      .where(inIds(baseRecords.id, batch))
      .orderBy(asc(baseRecords.seq));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = batch.map((id) => byId.get(id)).filter((row): row is BaseRecordRow => !!row);
    const filled = await fill(ordered, shown, { files: deps.files, memberId, baseId: at.base.id, viewer });
    const people = new Set<string>();
    for (const row of ordered) {
      for (const field of shown) {
        if (field.type !== 'member') continue;
        const value = filled.values.get(row.id)?.[field.id];
        if (Array.isArray(value)) for (const id of value) if (typeof id === 'string') people.add(id);
      }
    }
    const names = await memberNames(people);
    const cell = {
      timeZone: reader.timeZone,
      memberName: (id: string) => names.get(id),
      linkedTitle: (id: string) => filled.linked[id]?.title,
      fileName: (id: string) => filled.files[id]?.name,
    };
    return ordered
      .map((row) => {
        const values = { ...filled.values.get(row.id), ...(row.computed ?? {}) };
        return csvLine(
          fields.map(({ row: field, view, number }): CsvCell => {
            const text = formatCell(view, values[field.id], cell);
            return number && typeof values[field.id] === 'number' ? { number: text } : text;
          }),
        );
      })
      .map((line) => `${line}\r\n`)
      .join('');
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          started = true;
          const head = encoder.encode(`\uFEFF${csvLine(shown.map((field) => field.name))}\r\n`);
          bytes += head.length;
          controller.enqueue(head);
          return;
        }
        if (index >= ids.length || bytes >= MAX_EXPORT_BYTES) {
          if (bytes >= MAX_EXPORT_BYTES) {
            logger.warn('[tables] an export stopped at its size cap', { table: tableId, rows: index });
          }
          controller.close();
          return;
        }
        const batch = ids.slice(index, index + BATCH);
        index += batch.length;
        const chunk = encoder.encode(await lines(batch));
        bytes += chunk.length;
        controller.enqueue(chunk);
      } catch (error) {
        controller.error(error);
      }
    },
  });
  const day = new Date().toISOString().slice(0, 10);
  // exportFilename makes the name safe and adds .md; the extension is ours to choose.
  const name = exportFilename(at.table.name, 'table').slice(0, -3);
  return { filename: `${name}-${day}.csv`, body };
}

/** All of an export's text at once (tests). */
export async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(body).text();
}
