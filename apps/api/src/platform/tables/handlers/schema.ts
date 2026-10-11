/**
 * Tables, fields and schema versions. Structure changes need builder; taking a
 * table away from everyone needs owner (lifecycle spec D3). A custom role reads
 * only the tables it has a rule for and, in them, only its readable fields;
 * schema history (every field that ever existed) is builder-only.
 *
 * Apps D6: archiving a table or field, or dropping select options, that a
 * draft or published app uses answers 409 `used_by_apps` with the places
 * (`../app-references.ts`) until resent with `confirm: true`.
 */

import { effectiveUserId } from '@greenhouse/platform-kernel';
import { parseTableFieldConfig } from '@greenhouse/db';
import { TABLE_FIELD_TYPES, type TableFieldConfig, type TableFieldType } from '@greenhouse/types/tables';
import { baseForField, baseForTable, customAccessLens, requireBase } from '../access.js';
import { trimSchema, visibleTables } from '../access-trim.js';
import { usedByApps } from '../app-references.js';
import {
  fail,
  nullableString,
  objectValue,
  ok,
  optionalNumber,
  payloadOf,
  positiveInt,
  stringValue,
  type Handler,
  type TablesHandlers,
} from './shared.js';

/** Option ids a select field's new config drops (none for other types or a config without options). */
async function removedOptionIds(
  context: Parameters<Handler>[1],
  fieldId: number,
  config: TableFieldConfig,
): Promise<string[]> {
  const field = await context.db.tables.getField(fieldId);
  if (!field || (field.type !== 'single_select' && field.type !== 'multi_select') || !Array.isArray(config.options)) {
    return [];
  }
  const kept = new Set(config.options.map((option) => option.id));
  return (parseTableFieldConfig(field).options ?? []).map((option) => option.id).filter((id) => !kept.has(id));
}

const listTables: Handler = async (request, context) => {
  const baseId = positiveInt(payloadOf(request), 'baseId');
  if (!baseId) return fail('INVALID_INPUT', 'baseId is required');
  const grant = await requireBase(context, request.actor, baseId, 'table', 'viewer', { allowCustom: true });
  if (!grant) return fail('NOT_FOUND', 'Base not found');
  const tables = await context.db.tables.listTables(baseId);
  const lens = await customAccessLens(context, grant.access, effectiveUserId(request.actor));
  return ok({ tables: lens ? visibleTables(lens, tables) : tables });
};

const getSchema: Handler = async (request, context) => {
  const tableId = positiveInt(payloadOf(request), 'tableId');
  if (!tableId) return fail('INVALID_INPUT', 'tableId is required');
  const base = await baseForTable(context.db, tableId);
  const grant = base && (await requireBase(context, request.actor, base.id, 'table', 'viewer', { allowCustom: true }));
  if (!grant) return fail('NOT_FOUND', 'Table not found');
  const userId = effectiveUserId(request.actor);
  const schema = await context.db.tables.getSchema(tableId, userId);
  const lens = await customAccessLens(context, grant.access, userId);
  const visible = schema && lens ? trimSchema(lens, schema) : schema;
  return visible ? ok(visible) : fail('NOT_FOUND', 'Table not found');
};

const listSchemaVersions: Handler = async (request, context) => {
  const tableId = positiveInt(payloadOf(request), 'tableId');
  if (!tableId) return fail('INVALID_INPUT', 'tableId is required');
  const base = await baseForTable(context.db, tableId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'table', 'builder'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  return ok({ versions: await context.db.tables.listSchemaVersions(tableId) });
};

const getSchemaVersion: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const version = positiveInt(payload, 'version');
  if (!tableId || !version) return fail('INVALID_INPUT', 'tableId and version are required');
  const base = await baseForTable(context.db, tableId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'table', 'builder'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  const snapshot = await context.db.tables.getSchemaVersion(tableId, version);
  return snapshot ? ok({ version: snapshot }) : fail('NOT_FOUND', 'Schema version not found');
};

const createTable: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const baseId = positiveInt(payload, 'baseId');
  const name = stringValue(payload, 'name');
  if (!baseId || !name) return fail('INVALID_INPUT', 'baseId and name are required');
  if (!(await requireBase(context, request.actor, baseId, 'table', 'builder'))) {
    return fail('NOT_FOUND', 'Base not found');
  }
  return ok(
    await context.db.tables.createTable({
      base_id: baseId,
      name,
      description: stringValue(payload, 'description'),
      created_by: effectiveUserId(request.actor),
    }),
  );
};

const updateTable: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  if (!tableId) return fail('INVALID_INPUT', 'tableId is required');
  const base = await baseForTable(context.db, tableId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'table', 'builder'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  const table = await context.db.tables.updateTable(tableId, {
    name: stringValue(payload, 'name'),
    description: nullableString(payload, 'description'),
    position: optionalNumber(payload, 'position'),
  });
  return table ? ok({ table }) : fail('NOT_FOUND', 'Table not found');
};

/**
 * Owner, not builder — deliberately asymmetric with createTable/updateTable.
 * Building a table and taking one away from everyone who reads it are not
 * symmetric acts (spec D3). Records, links and fields survive the archive.
 */
const archiveTable: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  if (!tableId) return fail('INVALID_INPUT', 'tableId is required');
  const base = await baseForTable(context.db, tableId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'table', 'owner'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  const used = await usedByApps(context.db, base.id, { tableIds: [tableId] }, payload.confirm);
  if (used) return used;
  const table = await context.db.tables.archiveTable(tableId);
  return table ? ok({ table }) : fail('NOT_FOUND', 'Table not found');
};

const createField: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const name = stringValue(payload, 'name');
  const type = stringValue(payload, 'type') as TableFieldType | undefined;
  if (!tableId || !name || !type) return fail('INVALID_INPUT', 'tableId, name, and type are required');
  if (!TABLE_FIELD_TYPES.includes(type)) return fail('INVALID_INPUT', `Unsupported field type "${type}"`);
  // Phase 2 foundation: AI fields need their worker, budget and editor (slice AI) before anyone can make one.
  if (type === 'ai') return fail('INVALID_INPUT', 'not_implemented', { notImplemented: true });
  const base = await baseForTable(context.db, tableId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'field', 'builder'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  const field = await context.db.tables.createField({
    table_id: tableId,
    name,
    type,
    required: payload.required === true,
    config: objectValue<TableFieldConfig>(payload, 'config'),
    position: optionalNumber(payload, 'position'),
    created_by: effectiveUserId(request.actor),
  });
  return ok({ field });
};

const updateField: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const fieldId = positiveInt(payload, 'fieldId');
  if (!fieldId) return fail('INVALID_INPUT', 'fieldId is required');
  const base = await baseForField(context.db, fieldId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'field', 'builder'))) {
    return fail('NOT_FOUND', 'Field not found');
  }
  const config = objectValue<TableFieldConfig>(payload, 'config');
  const removed = config ? await removedOptionIds(context, fieldId, config) : [];
  if (removed.length > 0) {
    const used = await usedByApps(context.db, base.id, { options: { fieldId, optionIds: removed } }, payload.confirm);
    if (used) return used;
  }
  const field = await context.db.tables.updateField(fieldId, {
    updated_by: effectiveUserId(request.actor),
    name: stringValue(payload, 'name'),
    required: typeof payload.required === 'boolean' ? payload.required : undefined,
    config: objectValue<TableFieldConfig>(payload, 'config'),
    position: optionalNumber(payload, 'position'),
  });
  return field ? ok({ field }) : fail('NOT_FOUND', 'Field not found');
};

const archiveField: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const fieldId = positiveInt(payload, 'fieldId');
  if (!fieldId) return fail('INVALID_INPUT', 'fieldId is required');
  const base = await baseForField(context.db, fieldId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'field', 'builder'))) {
    return fail('NOT_FOUND', 'Field not found');
  }
  const used = await usedByApps(context.db, base.id, { fieldIds: [fieldId] }, payload.confirm);
  if (used) return used;
  const field = await context.db.tables.archiveField(fieldId, effectiveUserId(request.actor));
  return field ? ok({ field }) : fail('CONFLICT', 'Primary or unavailable fields cannot be archived');
};

export const schemaHandlers = {
  listTables,
  getSchema,
  listSchemaVersions,
  getSchemaVersion,
  createTable,
  updateTable,
  archiveTable,
  createField,
  updateField,
  archiveField,
} satisfies TablesHandlers;
