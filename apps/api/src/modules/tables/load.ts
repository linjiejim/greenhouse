/**
 * Loading what a call is about with the reader's access checked (a table, field, view or
 * record leads to its base), the JSON views of rows, and a page of records with their links,
 * files and linked titles filled in.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  BaseRole,
  BaseTable,
  Field,
  FieldConfig,
  LinkedRecord,
  RecordFile,
  TableRecord,
  View,
  ViewConfig,
} from '@greenhouse/contract';
import { isLinkType, roleAtLeast, viewConfigSchema } from '@greenhouse/contract';
import {
  baseFields,
  baseRecordFiles,
  baseRecordLinks,
  baseRecords,
  baseTables,
  baseViews,
  files,
  getDb,
  type BaseFieldRow,
  type BaseRecordRow,
  type BaseRow,
  type BaseTableRow,
  type BaseViewRow,
} from '@greenhouse/db';
import { notFound } from '../../http/errors.js';
import type { FilesService } from '../files/service.js';
import { baseAt, needsRole, type TablesReader } from './access.js';

export interface TableAt {
  base: BaseRow;
  role: BaseRole;
  table: BaseTableRow;
}

/** A data table and its base, with at least `needed`. An archived table only when asked for. */
export async function tableAt(
  reader: TablesReader,
  tableId: string,
  needed: BaseRole,
  options: { archived?: boolean } = {},
): Promise<TableAt> {
  const [table] = await getDb().select().from(baseTables).where(eq(baseTables.id, tableId));
  if (!table) throw notFound('Table');
  const { base, role } = await baseAt(reader, table.baseId, 'viewer');
  if (table.archivedAt && !options.archived) throw notFound('Table');
  if (!roleAtLeast(role, needed)) throw needsRole(needed);
  return { base, role, table };
}

/** A table's fields in order (the primary one first), live unless asked otherwise. */
export async function fieldsOf(tableIds: string | readonly string[], options: { archived?: boolean } = {}) {
  const ids = typeof tableIds === 'string' ? [tableIds] : [...tableIds];
  if (!ids.length) return [];
  return getDb()
    .select()
    .from(baseFields)
    .where(and(inArray(baseFields.tableId, ids), options.archived ? undefined : isNull(baseFields.archivedAt)))
    .orderBy(sql`${baseFields.isPrimary} DESC`, asc(baseFields.position), asc(baseFields.id));
}

export async function fieldAt(
  reader: TablesReader,
  fieldId: string,
  needed: BaseRole,
  options: { archived?: boolean } = {},
): Promise<TableAt & { field: BaseFieldRow }> {
  const [field] = await getDb().select().from(baseFields).where(eq(baseFields.id, fieldId));
  if (!field || (field.archivedAt && !options.archived)) throw notFound('Field');
  return { ...(await tableAt(reader, field.tableId, needed, options)), field };
}

/** A view the reader sees: shared, or their own personal one. */
export async function viewAt(reader: TablesReader, viewId: string): Promise<TableAt & { view: BaseViewRow }> {
  const [view] = await getDb().select().from(baseViews).where(eq(baseViews.id, viewId));
  if (!view || (view.ownerId && view.ownerId !== reader.memberId)) throw notFound('View');
  return { ...(await tableAt(reader, view.tableId, 'viewer')), view };
}

/** May the reader change this view: their personal view, or a shared one when they build the base. */
export const canEditView = (reader: TablesReader, role: BaseRole, view: Pick<BaseViewRow, 'ownerId'>) =>
  view.ownerId ? view.ownerId === reader.memberId : roleAtLeast(role, 'builder');

export async function recordAt(
  reader: TablesReader,
  recordId: string,
  needed: BaseRole,
  options: { deleted?: boolean } = {},
): Promise<TableAt & { record: BaseRecordRow }> {
  const [record] = await getDb().select().from(baseRecords).where(eq(baseRecords.id, recordId));
  if (!record || (record.deletedAt && !options.deleted)) throw notFound('Record');
  return { ...(await tableAt(reader, record.tableId, needed)), record };
}

/** Configs are stored only after normalizeConfig checked them against the contract. */
export const configOfField = (row: Pick<BaseFieldRow, 'config'>) => row.config as FieldConfig;

export const toField = (row: BaseFieldRow): Field => ({
  id: row.id,
  table_id: row.tableId,
  name: row.name,
  type: row.type,
  config: configOfField(row),
  required: row.required,
  is_primary: row.isPrimary,
  position: row.position,
});

export const toTable = (row: BaseTableRow, fields: readonly BaseFieldRow[]): BaseTable => ({
  id: row.id,
  base_id: row.baseId,
  name: row.name,
  description: row.description,
  position: row.position,
  fields: fields.filter((field) => field.tableId === row.id).map(toField),
});

/** A stored config as the contract reads it (a config saved by an older build drops what it no longer knows). */
export const configOf = (row: Pick<BaseViewRow, 'config'>): ViewConfig => {
  const parsed = viewConfigSchema.safeParse(row.config);
  return parsed.success ? parsed.data : {};
};

export const toView = (row: BaseViewRow, reader: TablesReader, role: BaseRole): View => ({
  id: row.id,
  table_id: row.tableId,
  name: row.name,
  type: row.type,
  personal: !!row.ownerId,
  config: configOf(row),
  position: row.position,
  revision: row.revision,
  editable: canEditView(reader, role, row),
});

export const toRecord = (row: BaseRecordRow, values: Record<string, unknown>): TableRecord => ({
  id: row.id,
  table_id: row.tableId,
  values,
  revision: row.revision,
  created_by: row.createdBy,
  created_at: row.createdAt,
  updated_by: row.updatedBy,
  updated_at: row.updatedAt,
});

export interface Filled {
  /** Values with links and files filled in, by record id. */
  values: Map<string, Record<string, unknown>>;
  linked: Record<string, LinkedRecord>;
  files: Record<string, RecordFile>;
}

/** Titles of records (their primary field's text) and the table each is in. */
export async function titlesOf(recordIds: readonly string[]): Promise<Record<string, LinkedRecord>> {
  if (!recordIds.length) return {};
  const rows = await getDb().execute<{ id: string; table_id: string; title: string | null }>(sql`
    SELECT r.id, r.table_id, r.values ->> f.id AS title
    FROM base_records r JOIN base_fields f ON f.table_id = r.table_id AND f.is_primary
    WHERE r.id IN (${sql.join(
      recordIds.map((id) => sql`${id}`),
      sql`, `,
    )})`);
  return Object.fromEntries([...rows].map((row) => [row.id, { title: row.title ?? '', table_id: row.table_id }]));
}

/**
 * Records' values with their link and attachment fields filled in from their own rows: links
 * only to live records of live tables, files only while they are there.
 */
export async function fill(
  rows: readonly BaseRecordRow[],
  fields: readonly BaseFieldRow[],
  deps: { files: Pick<FilesService, 'signedUrl'>; memberId: string },
): Promise<Filled> {
  const values = new Map(rows.map((row) => [row.id, { ...row.values }]));
  const ids = rows.map((row) => row.id);
  const linkFields = fields.filter((field) => isLinkType(field.type)).map((field) => field.id);
  const fileFields = fields.filter((field) => field.type === 'attachment').map((field) => field.id);
  for (const field of [...linkFields, ...fileFields]) for (const value of values.values()) delete value[field];
  const filled: Filled = { values, linked: {}, files: {} };
  if (!ids.length) return filled;
  const [links, attached] = await Promise.all([
    linkFields.length
      ? getDb()
          .select({
            field: baseRecordLinks.fieldId,
            source: baseRecordLinks.sourceRecordId,
            target: baseRecordLinks.targetRecordId,
          })
          .from(baseRecordLinks)
          .innerJoin(
            baseRecords,
            and(eq(baseRecords.id, baseRecordLinks.targetRecordId), isNull(baseRecords.deletedAt)),
          )
          .innerJoin(baseTables, and(eq(baseTables.id, baseRecords.tableId), isNull(baseTables.archivedAt)))
          .where(and(inArray(baseRecordLinks.sourceRecordId, ids), inArray(baseRecordLinks.fieldId, linkFields)))
          .orderBy(asc(baseRecordLinks.position), asc(baseRecordLinks.targetRecordId))
      : [],
    fileFields.length
      ? getDb()
          .select({
            record: baseRecordFiles.recordId,
            field: baseRecordFiles.fieldId,
            id: files.id,
            name: files.name,
            contentType: files.contentType,
            sizeBytes: files.sizeBytes,
          })
          .from(baseRecordFiles)
          .innerJoin(files, and(eq(files.id, baseRecordFiles.fileId), eq(files.status, 'active')))
          .where(and(inArray(baseRecordFiles.recordId, ids), inArray(baseRecordFiles.fieldId, fileFields)))
          .orderBy(asc(baseRecordFiles.position), asc(baseRecordFiles.fileId))
      : [],
  ]);
  const push = (recordId: string, field: string, id: string) => {
    const value = values.get(recordId)!;
    value[field] = [...((value[field] as string[] | undefined) ?? []), id];
  };
  for (const link of links) push(link.source, link.field, link.target);
  for (const file of attached) {
    push(file.record, file.field, file.id);
    filled.files[file.id] = {
      id: file.id,
      name: file.name,
      content_type: file.contentType,
      size_bytes: file.sizeBytes,
      url: deps.files.signedUrl(file.id, deps.memberId).url,
    };
  }
  filled.linked = await titlesOf([...new Set(links.map((link) => link.target))]);
  return filled;
}
