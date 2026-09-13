/**
 * Tables Mutation — confirm-gated record maintenance for Agent Proxy and MCP.
 *
 * Schema/permission mutations remain Web/REST-only in V1.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { defineTool, type ToolMeta } from './define.js';
import { dispatchTablesAgentAction } from '../platform/tables/agent-adapter.js';

const valuesSchema = z
  .record(z.string(), z.unknown())
  .describe('Record values keyed by stable numeric field ID strings from schema.get.');

const batchItemSchema = z.object({
  record_id: z.number().int().positive().optional().describe('Existing record ID; omit to create.'),
  revision: z.number().int().positive().optional().describe('Required with record_id for optimistic concurrency.'),
  values: valuesSchema,
});

const tablesMutationSchema = z.object({
  action: z
    .enum(['records.create', 'records.update', 'records.upsert', 'records.batch_upsert', 'records.delete'])
    .describe('Bounded record mutation action.'),
  table_id: z.number().int().positive().describe('Target Table ID.'),
  record_id: z.number().int().positive().optional().describe('Existing record ID for update/upsert/delete.'),
  revision: z.number().int().positive().optional().describe('Current revision for update/upsert/delete.'),
  values: valuesSchema.optional().describe('Create/update values keyed by field ID.'),
  items: z.array(batchItemSchema).min(1).max(100).optional().describe('Batch upsert items, maximum 100.'),
});

type TablesMutationInput = z.infer<typeof tablesMutationSchema>;

export interface TablesMutationContext {
  userId: string;
}

const meta: ToolMeta = {
  id: 'tables_mutation',
  name: 'Tables Mutation',
  brief: 'Create, update, upsert, and delete table records',
  description: `Confirm-gated record maintenance for the internal Tables application.

Supported actions are records.create, records.update, records.upsert, records.batch_upsert, and records.delete. Read schema and the current record with tables_query first. Updates/deletes require the current revision and fail on conflicts; never retry by overwriting an unknown newer revision. Values use stable field ID strings, not field names. Schema, Base membership, views, and dashboards cannot be changed with this tool.`,
  category: 'team',
  is_global: false,
  surface: { proxy: 'write', mcp: 'tables' },
  icon: 'TableProperties',
  sort_order: 29,
};

export function createTablesMutationTool(ctx: TablesMutationContext) {
  return tool({
    description: meta.description,
    inputSchema: tablesMutationSchema,
    execute: async (input: TablesMutationInput) => {
      const context = { userId: ctx.userId };
      if (input.action === 'records.create') {
        if (!input.values) return { error: 'values is required' };
        const result = await dispatchTablesAgentAction(
          context,
          'createRecord',
          { tableId: input.table_id, values: input.values },
          { tableId: input.table_id },
        );
        return result.ok ? result.data : { error: result.message, details: result.details };
      }
      if (input.action === 'records.batch_upsert') {
        if (!input.items) return { error: 'items is required' };
        const result = await dispatchTablesAgentAction(
          context,
          'batchUpsertRecords',
          { tableId: input.table_id, items: input.items },
          { tableId: input.table_id },
        );
        return result.ok ? result.data : { error: result.message, details: result.details };
      }
      if (input.action === 'records.upsert' && !input.record_id) {
        if (!input.values) return { error: 'values is required' };
        const result = await dispatchTablesAgentAction(
          context,
          'createRecord',
          { tableId: input.table_id, values: input.values },
          { tableId: input.table_id },
        );
        return result.ok ? result.data : { error: result.message, details: result.details };
      }
      if (input.action === 'records.delete') {
        if (!input.record_id || !input.revision) return { error: 'record_id and revision are required' };
        const result = await dispatchTablesAgentAction(
          context,
          'deleteRecord',
          { tableId: input.table_id, recordId: input.record_id, revision: input.revision },
          { tableId: input.table_id, recordId: input.record_id },
        );
        return result.ok ? result.data : { error: result.message, details: result.details };
      }
      if (!input.record_id || !input.revision || !input.values) {
        return { error: 'record_id, revision, and values are required' };
      }
      const result = await dispatchTablesAgentAction(
        context,
        'updateRecord',
        {
          tableId: input.table_id,
          recordId: input.record_id,
          revision: input.revision,
          values: input.values,
        },
        { tableId: input.table_id, recordId: input.record_id },
      );
      return result.ok ? result.data : { error: result.message, details: result.details };
    },
  });
}

export const tablesMutationTool = defineTool({ meta, kind: 'lazy' });
