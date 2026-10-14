/**
 * Loading what a call is about with the reader's access checked (a table, field, view or
 * record leads to its base; a custom role may hide tables and records), the JSON views of rows,
 * and a page of records with their links, files and linked titles filled in. Something the
 * reader may not reach is not found as the thing asked for, whatever stopped it.
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
import {
  asNotFound,
  baseAt,
  needsRole,
  type CustomAccess,
  type CustomTableRules,
  type TablesReader,
} from './access.js';
import { presentConfig } from './computed-fields.js';
import { inIds } from './query.js';
import { recordVisible, rowsOf } from './scope.js';

export interface TableAt {
  base: BaseRow;
  role: BaseRole;
  table: BaseTableRow;
  /** The reader's custom roles in the base (null for the four roles)... */
  access: CustomAccess | null;
  /** ...and what they allow in this table. */
  custom: CustomTableRules | null;
}

/**
 * A data table and its base, with at least `needed`. An archived table only when asked for. A
 * custom role must see the table, and edit it for `editor`; it never builds.
 */
export async function tableAt(
  reader: TablesReader,
  tableId: string,
  needed: BaseRole,
  options: { archived?: boolean; kind?: string } = {},
): Promise<TableAt> {
  const kind = options.kind ?? 'Table';
  const [table] = await getDb().select().from(baseTables).where(eq(baseTables.id, tableId));
  if (!table) throw notFound(kind);
  const { base, role, custom: access } = await asNotFound(kind, () => baseAt(reader, table.baseId, 'viewer'));
  if (table.archivedAt && !options.archived) throw notFound(kind);
  const custom = access ? (access.tables.get(table.id) ?? null) : null;
  if (access && !custom) throw notFound(kind);
  if (!roleAtLeast(role, needed)) throw needsRole(needed);
  if (custom && needed !== 'viewer' && custom.access !== 'edit') throw needsRole(needed);
  return { base, role, table, access, custom };
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
  if (!field) throw notFound('Field');
  const at = await tableAt(reader, field.tableId, needed, { ...options, kind: 'Field' });
  if ((field.archivedAt && !options.archived) || at.custom?.hidden.has(field.id)) throw notFound('Field');
  return { ...at, field };
}

/** A view or dashboard the reader sees, with its table (none for a dashboard). */
export interface ViewAt {
  base: BaseRow;
  role: BaseRole;
  table: BaseTableRow | null;
  access: CustomAccess | null;
  view: BaseViewRow;
}

/** A view the reader sees: shared, or their own personal one. A dashboard has no table. */
export async function viewAt(reader: TablesReader, viewId: string): Promise<ViewAt> {
  const [view] = await getDb().select().from(baseViews).where(eq(baseViews.id, viewId));
  if (!view || (view.ownerId && view.ownerId !== reader.memberId)) throw notFound('View');
  if (!view.tableId) {
    const { base, role, custom } = await asNotFound('View', () => baseAt(reader, view.baseId, 'viewer'));
    return { base, role, table: null, access: custom, view };
  }
  const at = await tableAt(reader, view.tableId, 'viewer', { kind: 'View' });
  return { base: at.base, role: at.role, table: at.table, access: at.access, view };
}

/** May the reader change this view: their personal view, or a shared one when they build the base. */
export const canEditView = (reader: TablesReader, role: BaseRole, view: Pick<BaseViewRow, 'ownerId'>) =>
  view.ownerId ? view.ownerId === reader.memberId : roleAtLeast(role, 'builder');

/**
 * A record with its table, the reader's access checked first: a record they may not reach is not
 * found whether it is live, deleted or not there. A deleted one only when asked for, and only for
 * editors (the recycle bin is theirs).
 */
export async function recordAt(
  reader: TablesReader,
  recordId: string,
  needed: BaseRole,
  options: { deleted?: boolean } = {},
): Promise<TableAt & { record: BaseRecordRow }> {
  const [record] = await getDb().select().from(baseRecords).where(eq(baseRecords.id, recordId));
  if (!record) throw notFound('Record');
  const at = await tableAt(reader, record.tableId, needed, { kind: 'Record', archived: options.deleted });
  if (record.deletedAt && !options.deleted) throw notFound('Record');
  if (record.deletedAt && (!roleAtLeast(at.role, 'editor') || at.access)) throw notFound('Record');
  if (at.custom && !(await recordVisible(reader, at, record.id))) throw notFound('Record');
  return { ...at, record };
}

/** Configs are stored only after normalizeConfig checked them against the contract. */
export const configOfField = (row: Pick<BaseFieldRow, 'config'>) => row.config as FieldConfig;

/**
 * A field as the API answers it. Given its table's fields, a formula comes with its text and an
 * AI prompt with field names (computed-fields.ts).
 */
export const toField = (row: BaseFieldRow, fields?: readonly BaseFieldRow[]): Field => ({
  id: row.id,
  table_id: row.tableId,
  name: row.name,
  type: row.type,
  config: presentConfig(row, fields),
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
  schema_revision: row.schemaRevision,
  fields: fields.filter((field) => field.tableId === row.id).map((field, _index, own) => toField(field, own)),
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

/**
 * A record as the API answers it: `values` are its stored values (links and files filled in)
 * and what its computed fields worked out, for the fields given (the reader's).
 */
export const toRecord = (
  row: BaseRecordRow,
  values: Record<string, unknown>,
  fields?: readonly Pick<BaseFieldRow, 'id' | 'type'>[],
): TableRecord => ({
  id: row.id,
  table_id: row.tableId,
  values: withComputed(row, values, fields),
  revision: row.revision,
  computed_revision: row.computedRevision,
  created_by: row.createdBy,
  created_at: row.createdAt,
  updated_by: row.updatedBy,
  updated_at: row.updatedAt,
});

/** Stored values plus computed ones, keeping only `fields` when given. */
export function withComputed(
  row: Pick<BaseRecordRow, 'computed'>,
  values: Record<string, unknown>,
  fields?: readonly Pick<BaseFieldRow, 'id' | 'type'>[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...values };
  for (const [key, value] of Object.entries(row.computed ?? {})) merged[key] = value;
  if (!fields) return merged;
  const kept: Record<string, unknown> = {};
  for (const field of fields) if (field.id in merged) kept[field.id] = merged[field.id];
  return kept;
}

export interface Filled {
  /** Values with links and files filled in, by record id. */
  values: Map<string, Record<string, unknown>>;
  linked: Record<string, LinkedRecord>;
  files: Record<string, RecordFile>;
}

/** Who reads titles through a custom role: titles of records it may not see stay empty. */
export interface TitleViewer {
  reader: TablesReader;
  access: CustomAccess;
}

/** The title viewer for a reader at a table (none for the four roles). */
export const viewerOf = (reader: TablesReader, at: { access: CustomAccess | null }): TitleViewer | null =>
  at.access ? { reader, access: at.access } : null;

/**
 * Titles of records (their primary field's text) and the table each is in, only for records of
 * `baseId` (an id from elsewhere names nothing). For a custom role, a record in a table it does
 * not see, or outside its records there, has an empty title.
 */
export async function titlesOf(
  baseId: string,
  recordIds: readonly string[],
  viewer?: TitleViewer | null,
): Promise<Record<string, LinkedRecord>> {
  if (!recordIds.length) return {};
  const rows = await getDb().execute<{ id: string; table_id: string; title: string | null }>(sql`
    SELECT r.id, r.table_id, r.values ->> f.id AS title
    FROM base_records r
    JOIN base_tables t ON t.id = r.table_id AND t.base_id = ${baseId}
    JOIN base_fields f ON f.table_id = r.table_id AND f.is_primary
    WHERE ${inIds(sql`r.id`, recordIds)}`);
  const found = [...rows];
  const hidden = new Set<string>();
  if (viewer) {
    for (const tableId of new Set(found.map((row) => row.table_id))) {
      const rules = viewer.access.tables.get(tableId);
      const ids = found.filter((row) => row.table_id === tableId).map((row) => row.id);
      if (!rules) {
        for (const id of ids) hidden.add(id);
        continue;
      }
      const condition = await rowsOf(viewer.reader, { table: { id: tableId }, custom: rules });
      if (!condition) continue;
      const seen = await getDb()
        .select({ id: baseRecords.id })
        .from(baseRecords)
        .where(and(inIds(baseRecords.id, ids), condition));
      const visible = new Set(seen.map((row) => row.id));
      for (const id of ids) if (!visible.has(id)) hidden.add(id);
    }
  }
  return Object.fromEntries(
    found.map((row) => [row.id, { title: hidden.has(row.id) ? '' : (row.title ?? ''), table_id: row.table_id }]),
  );
}

/**
 * Records' values with their link and attachment fields filled in from their own rows: links
 * only to live records of live tables, files only while they are there.
 */
export async function fill(
  rows: readonly BaseRecordRow[],
  fields: readonly BaseFieldRow[],
  deps: {
    files: Pick<FilesService, 'signedUrl'>;
    memberId: string;
    /** The base the records are in (looked up when not given); linked titles come only from it. */
    baseId?: string;
    viewer?: TitleViewer | null;
  },
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
  const targets = [...new Set(links.map((link) => link.target))];
  if (targets.length) {
    const baseId = deps.baseId ?? (await baseOfTable(rows[0]!.tableId));
    filled.linked = baseId ? await titlesOf(baseId, targets, deps.viewer) : {};
  }
  return filled;
}

async function baseOfTable(tableId: string): Promise<string | null> {
  const [row] = await getDb().select({ baseId: baseTables.baseId }).from(baseTables).where(eq(baseTables.id, tableId));
  return row?.baseId ?? null;
}
