/**
 * Record data. Every handler goes through `requireTableData`, hands its scope to
 * db.tables (never optional there), projects what it returns with the same
 * access, and announces committed writes (`publishRecordsChanged`). Ids outside
 * the scope answer 404, exactly like ids that do not exist.
 */

import type { BatchUpsertTableRecordItem } from '@greenhouse/db';
import type { TableAggregateInput, TableQuery, TableRecordValues } from '@greenhouse/types/tables';
import { requireTableData } from '../access.js';
import { publishRecordsChanged } from '../realtime.js';
import {
  fail,
  objectValue,
  ok,
  payloadOf,
  positiveInt,
  writeMeta,
  type Handler,
  type TablesHandlers,
} from './shared.js';

function batchItems(payload: Record<string, unknown>): BatchUpsertTableRecordItem[] | undefined {
  return Array.isArray(payload.items) ? (payload.items as BatchUpsertTableRecordItem[]) : undefined;
}

const getRecord: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const recordId = positiveInt(payload, 'recordId');
  if (!tableId || !recordId) return fail('INVALID_INPUT', 'tableId and recordId are required');
  // A masked `record.values` policy may still open one record — with every value
  // (stored and computed) removed by `project`.
  const data = await requireTableData(request, context, tableId, 'read', { allowMaskedValues: true });
  if (!data) return fail('NOT_FOUND', 'Record not found');
  const record = await context.db.tables.getRecord(tableId, recordId, data.scope);
  return record ? ok({ record: data.project(record) }) : fail('NOT_FOUND', 'Record not found');
};

const queryRecords: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  if (!tableId) return fail('INVALID_INPUT', 'tableId is required');
  const data = await requireTableData(request, context, tableId, 'read');
  if (!data) return fail('NOT_FOUND', 'Table not found');
  const result = await context.db.tables.queryRecords(
    tableId,
    objectValue<TableQuery>(payload, 'query') ?? {},
    data.scope,
  );
  return ok({ ...result, records: result.records.map((record) => data.project(record)) });
};

const aggregateRecords: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const input = objectValue<TableAggregateInput>(payload, 'input');
  if (!tableId || !input) return fail('INVALID_INPUT', 'tableId and input are required');
  const data = await requireTableData(request, context, tableId, 'read');
  if (!data) return fail('NOT_FOUND', 'Table not found');
  return ok({ rows: await context.db.tables.aggregateRecords(tableId, input, data.scope) });
};

const createRecord: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const values = objectValue<TableRecordValues>(payload, 'values');
  if (!tableId || !values) return fail('INVALID_INPUT', 'tableId and values are required');
  const data = await requireTableData(request, context, tableId, 'create');
  if (!data) return fail('NOT_FOUND', 'Table not found');
  const record = await context.db.tables.createRecord(
    { table_id: tableId, values },
    data.scope,
    writeMeta(request.actor),
  );
  await publishRecordsChanged(context, data.base, tableId, [record.id]);
  return ok({ record: data.project(record) });
};

const updateRecord: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const recordId = positiveInt(payload, 'recordId');
  const revision = positiveInt(payload, 'revision');
  const values = objectValue<TableRecordValues>(payload, 'values');
  if (!tableId || !recordId || !revision || !values) {
    return fail('INVALID_INPUT', 'tableId, recordId, revision, and values are required');
  }
  const data = await requireTableData(request, context, tableId, 'update');
  if (!data) return fail('NOT_FOUND', 'Record not found');
  const result = await context.db.tables.updateRecord(
    { table_id: tableId, record_id: recordId, revision, values },
    data.scope,
    writeMeta(request.actor),
  );
  if (result.ok) {
    await publishRecordsChanged(context, data.base, tableId, [result.record.id]);
    return ok({ record: data.project(result.record) });
  }
  return result.reason === 'conflict'
    ? fail('CONFLICT', 'Record revision conflict', { currentRevision: result.current })
    : fail('NOT_FOUND', 'Record not found');
};

const batchUpsertRecords: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const items = batchItems(payload);
  if (!tableId || !items) return fail('INVALID_INPUT', 'tableId and items are required');
  const data = await requireTableData(request, context, tableId, 'update');
  if (!data) return fail('NOT_FOUND', 'Table not found');
  const results = await context.db.tables.batchUpsertRecords(
    { table_id: tableId, items },
    data.scope,
    writeMeta(request.actor),
  );
  await publishRecordsChanged(
    context,
    data.base,
    tableId,
    results.flatMap((result) => (result.ok ? [result.record.id] : [])),
  );
  return ok({
    results: results.map((result) => (result.ok ? { ...result, record: data.project(result.record) } : result)),
  });
};

const validateBatchRecords: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const items = batchItems(payload);
  if (!tableId || !items) return fail('INVALID_INPUT', 'tableId and items are required');
  const data = await requireTableData(request, context, tableId, 'update');
  if (!data) return fail('NOT_FOUND', 'Table not found');
  return ok({ results: await context.db.tables.validateBatchRecords({ table_id: tableId, items }, data.scope) });
};

const deleteRecord: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const recordId = positiveInt(payload, 'recordId');
  const revision = positiveInt(payload, 'revision');
  if (!tableId || !recordId || !revision) {
    return fail('INVALID_INPUT', 'tableId, recordId, and revision are required');
  }
  const data = await requireTableData(request, context, tableId, 'delete');
  if (!data) return fail('NOT_FOUND', 'Record not found');
  const result = await context.db.tables.deleteRecord(
    { table_id: tableId, record_id: recordId, revision },
    data.scope,
    writeMeta(request.actor),
  );
  if (result.ok) {
    await publishRecordsChanged(context, data.base, tableId, [result.record.id]);
    return ok({ record: data.project(result.record) });
  }
  return result.reason === 'conflict'
    ? fail('CONFLICT', 'Record revision conflict', { currentRevision: result.current })
    : fail('NOT_FOUND', 'Record not found');
};

const listDeletedRecords: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  if (!tableId) return fail('INVALID_INPUT', 'tableId is required');
  const data = await requireTableData(request, context, tableId, 'delete');
  if (!data) return fail('NOT_FOUND', 'Table not found');
  const records = await context.db.tables.listDeletedRecords(tableId, data.scope, positiveInt(payload, 'limit') ?? 100);
  return ok({ records: records.map((record) => data.project(record)) });
};

const restoreRecord: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const recordId = positiveInt(payload, 'recordId');
  if (!tableId || !recordId) return fail('INVALID_INPUT', 'tableId and recordId are required');
  const data = await requireTableData(request, context, tableId, 'delete');
  if (!data) return fail('NOT_FOUND', 'Record not found');
  const result = await context.db.tables.restoreRecord(
    { table_id: tableId, record_id: recordId },
    data.scope,
    writeMeta(request.actor),
  );
  if (!result.ok) return fail('NOT_FOUND', 'Record not found');
  await publishRecordsChanged(context, data.base, tableId, [result.record.id]);
  return ok({ record: data.project(result.record) });
};

export const recordHandlers = {
  getRecord,
  queryRecords,
  aggregateRecords,
  createRecord,
  updateRecord,
  validateBatchRecords,
  batchUpsertRecords,
  deleteRecord,
  listDeletedRecords,
  restoreRecord,
} satisfies TablesHandlers;
