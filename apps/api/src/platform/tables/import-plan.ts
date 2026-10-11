/**
 * Tables import — from a staged file and a mapping to record values.
 *
 * Shared by the dry run (`previewImport` with a mapping) and the commit, so
 * "what the preview says will fail" and "what the commit refuses" are the same
 * code: mapping validation, the coercion context (members, relation labels in
 * the writer's read scope, day / month order per column) and the per-row
 * values. Field writes, permissions on records and required fields are still
 * enforced by db.tables when the commit writes.
 */

import {
  buildImportUserDirectory,
  coerceImportValue,
  inferImportColumnType,
  inferImportDateOrder,
  matchImportHeader,
  missingSelectLabels,
  parseTableFieldConfig,
  tableImportRowNumber,
  withImportedOptions,
  type ImportField,
  type ImportValueContext,
  type TableFieldRow,
  type TableImportChunkItem,
  type TableImportPlan,
  type TableImportPlanColumn,
} from '@greenhouse/db';
import type { PlatformActionRequest } from '@greenhouse/platform-kernel';
import type { TableAccessScope } from '@greenhouse/types/table-access';
import {
  isComputedFieldType,
  type TableFieldType,
  type TableImportColumn,
  type TableImportMapping,
} from '@greenhouse/types/tables';
import type { PlatformHandlerContext } from '../runtime.js';
import { requireTableData } from './access.js';

/** Types a column may become when the import creates its field (relations need a target, attachments cannot be imported). */
export const IMPORT_CREATABLE_TYPES: readonly TableFieldType[] = [
  'text',
  'long_text',
  'number',
  'boolean',
  'date',
  'datetime',
  'single_select',
  'multi_select',
  'user',
  'multi_user',
  'url',
  'email',
  'phone',
];

const SAMPLE_ROWS = 5;
const INFERENCE_ROWS = 500;

/** A mapping problem the caller can fix; `forbidden` ones are 403. */
export class ImportMappingError extends Error {
  constructor(
    message: string,
    readonly forbidden: boolean = false,
  ) {
    super(message);
    this.name = 'ImportMappingError';
  }
}

/** A field the import may write: active, stored, not an attachment, and editable for a scoped writer. */
export function isImportTarget(field: TableFieldRow, scope: TableAccessScope): boolean {
  if (field.archived_at || isComputedFieldType(field.type) || field.type === 'attachment') return false;
  return scope.kind === 'full' || scope.editableFieldIds.includes(field.id);
}

function columnValues(rows: readonly string[][], column: number, limit = Number.POSITIVE_INFINITY): string[] {
  const values: string[] = [];
  for (const row of rows) {
    if (values.length >= limit) break;
    values.push(row[column] ?? '');
  }
  return values;
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base.slice(0, 120);
  for (let suffix = 2; taken.has(name.toLowerCase()); suffix += 1) name = `${base.slice(0, 114)} ${suffix}`;
  taken.add(name.toLowerCase());
  return name;
}

/**
 * Preview columns: header, a few samples, the inferred type and a suggested
 * destination. `fields` includes archived ones (their names stay taken).
 */
export function previewColumns(input: {
  header: string[];
  rows: string[][];
  fields: TableFieldRow[];
  scope: TableAccessScope;
  canCreateFields: boolean;
}): TableImportColumn[] {
  const targets = input.fields.filter((field) => isImportTarget(field, input.scope));
  const taken = new Set(input.fields.map((field) => field.name.toLowerCase()));
  const used = new Set<number>();
  return input.header.map((header, index) => {
    const inferredType = inferImportColumnType(columnValues(input.rows, index, INFERENCE_ROWS));
    const match = matchImportHeader(header, targets);
    let suggestion: TableImportColumn['suggestion'];
    if (match && !used.has(match.id)) {
      used.add(match.id);
      suggestion = { fieldId: match.id };
    } else if (input.canCreateFields) {
      suggestion = { create: { name: uniqueName(header.trim() || `Column ${index + 1}`, taken), type: inferredType } };
    }
    return {
      index,
      header,
      samples: columnValues(input.rows, index, SAMPLE_ROWS),
      inferredType,
      ...(suggestion ? { suggestion } : {}),
    };
  });
}

/**
 * Check a requested mapping against the table and the caller's rights and turn
 * it into plan columns. Creating fields and adding options need `canBuild`;
 * every target must be importable for the caller's scope. `fields` includes
 * archived ones: a new field may not reuse their names either.
 */
export function planColumns(input: {
  mapping: unknown;
  width: number;
  fields: TableFieldRow[];
  scope: TableAccessScope;
  canBuild: boolean;
  createOptions: boolean;
}): TableImportPlanColumn[] {
  if (!Array.isArray(input.mapping) || input.mapping.length === 0) {
    throw new ImportMappingError('Map at least one column to a field');
  }
  if (input.createOptions && !input.canBuild) {
    throw new ImportMappingError('Adding select options needs builder access', true);
  }
  const byId = new Map(input.fields.map((field) => [field.id, field]));
  const taken = new Set(input.fields.map((field) => field.name.toLowerCase()));
  const columns = new Set<number>();
  const fieldIds = new Set<number>();
  const plan: TableImportPlanColumn[] = [];
  for (const entry of input.mapping as TableImportMapping[]) {
    const column = (entry as { column?: unknown })?.column;
    if (typeof column !== 'number' || !Number.isInteger(column) || column < 0 || column >= input.width) {
      throw new ImportMappingError('A mapping names a column the file does not have');
    }
    if (columns.has(column)) throw new ImportMappingError('A column is mapped twice');
    columns.add(column);
    if ('fieldId' in entry && entry.fieldId !== undefined) {
      const field = byId.get(entry.fieldId);
      if (!field || field.archived_at) throw new ImportMappingError(`Field ${entry.fieldId} is unavailable`);
      if (isComputedFieldType(field.type) || field.type === 'attachment') {
        throw new ImportMappingError(`"${field.name}" cannot be imported into`);
      }
      if (!isImportTarget(field, input.scope)) throw new ImportMappingError(`"${field.name}" is not editable`, true);
      if (fieldIds.has(field.id)) throw new ImportMappingError(`"${field.name}" is mapped twice`);
      fieldIds.add(field.id);
      plan.push({ column, fieldId: field.id });
      continue;
    }
    const create = (entry as { create?: { name?: unknown; type?: unknown } }).create;
    if (!create || typeof create !== 'object') throw new ImportMappingError('A mapping has no destination');
    if (!input.canBuild) throw new ImportMappingError('Creating fields needs builder access', true);
    const name = typeof create.name === 'string' ? create.name.trim() : '';
    if (!name || name.length > 120) throw new ImportMappingError('New fields need a name of 1–120 characters');
    if (taken.has(name.toLowerCase())) throw new ImportMappingError(`A field named "${name}" already exists`);
    taken.add(name.toLowerCase());
    const type = create.type as TableFieldType;
    if (!IMPORT_CREATABLE_TYPES.includes(type)) {
      throw new ImportMappingError(`New fields cannot be of type "${String(create.type)}"`);
    }
    plan.push({ column, create: { name, type } });
  }
  return plan;
}

/** The distinct labels a select column would add: every new label, in order. */
export function columnSelectLabels(field: ImportField, rows: readonly string[][], column: number): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const label of missingSelectLabels(field, row[column] ?? '')) {
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      labels.push(label);
    }
  }
  return labels;
}

/** The config a new field for this column is created with (select fields get the column's labels). */
export function createdFieldConfig(
  create: NonNullable<TableImportPlanColumn['create']>,
  rows: readonly string[][],
  column: number,
): ImportField['config'] {
  if (create.type !== 'single_select' && create.type !== 'multi_select') return {};
  const blank: ImportField = { id: 0, name: create.name, type: create.type, config: { options: [] } };
  return { options: withImportedOptions([], columnSelectLabels(blank, rows, column)) };
}

export function importField(field: TableFieldRow): ImportField {
  return { id: field.id, name: field.name, type: field.type, config: parseTableFieldConfig(field) };
}

export interface ImportColumnContext {
  column: number;
  field: ImportField;
  ctx: ImportValueContext;
}

function relationLabelsWanted(field: ImportField, rows: readonly string[][], column: number): string[] {
  const labels = new Set<string>();
  const multiple = field.config.relation?.multiple === true;
  for (const row of rows) {
    const text = (row[column] ?? '').trim();
    if (!text) continue;
    labels.add(text);
    if (multiple) for (const part of text.split(/\s*[,;，；、\n]\s*/)) if (part.trim()) labels.add(part.trim());
  }
  return [...labels];
}

/**
 * Everything coercion needs per mapped column. Relation labels resolve only
 * among records the caller may read on the target table (D14): no read access,
 * or a hidden primary field, and nothing matches.
 */
export async function loadColumnContexts(input: {
  request: Pick<PlatformActionRequest, 'actor'>;
  context: Pick<PlatformHandlerContext, 'db'>;
  columns: Array<{ column: number; field: ImportField }>;
  rows: readonly string[][];
  timeZone: string;
}): Promise<ImportColumnContext[]> {
  const { db } = input.context;
  const needsUsers = input.columns.some(({ field }) => field.type === 'user' || field.type === 'multi_user');
  const users = needsUsers
    ? buildImportUserDirectory(
        (await db.users.list())
          .filter((user) => user.status === 'active' && (user.role === 'team' || user.role === 'super'))
          .map((user) => ({ id: user.id, email: user.email, nickname: user.nickname })),
      )
    : undefined;
  const contexts: ImportColumnContext[] = [];
  for (const { column, field } of input.columns) {
    const ctx: ImportValueContext = {
      timeZone: input.timeZone,
      users,
      ...(field.type === 'date' || field.type === 'datetime'
        ? { dateOrder: inferImportDateOrder(columnValues(input.rows, column)) }
        : {}),
    };
    const targetTableId = field.type === 'relation' ? field.config.relation?.targetTableId : undefined;
    if (targetTableId) {
      const target = await requireTableData(input.request, input.context, targetTableId, 'read');
      const primary = target
        ? (await db.tables.listFields(targetTableId)).find((entry) => entry.is_primary)
        : undefined;
      if (target && primary) {
        ctx.relationLabels = await db.tables.matchImportRelationLabels(
          targetTableId,
          primary.id,
          relationLabelsWanted(field, input.rows, column),
          target.scope,
        );
      }
    }
    contexts.push({ column, field, ctx });
  }
  return contexts;
}

/** Data row `index` → chunk item (values, or the reasons its cells cannot be read). */
export function importRowItem(
  row: readonly string[],
  index: number,
  columns: readonly ImportColumnContext[],
  hasHeader: boolean,
): TableImportChunkItem {
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const { column, field, ctx } of columns) {
    const result = coerceImportValue(field, row[column] ?? '', ctx);
    if (!result.ok) errors.push(result.error);
    else if (result.value !== undefined) values[String(field.id)] = result.value;
  }
  const rowNumber = tableImportRowNumber(index, hasHeader);
  return errors.length > 0 ? { row: rowNumber, errors } : { row: rowNumber, values };
}

/** A valid IANA zone from the request, else UTC. */
export function planTimeZone(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return 'UTC';
  }
}

export function planFromRequest(input: {
  columns: TableImportPlanColumn[];
  hasHeader: unknown;
  createOptions: unknown;
  timezone: unknown;
}): TableImportPlan {
  return {
    columns: input.columns,
    hasHeader: input.hasHeader !== false,
    createOptions: input.createOptions === true,
    timeZone: planTimeZone(input.timezone),
  };
}
