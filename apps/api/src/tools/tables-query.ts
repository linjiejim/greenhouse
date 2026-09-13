/**
 * Tables Query — bounded read access for chat, Agent Proxy, and MCP.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { defineTool, type ToolMeta } from './define.js';
import { dispatchTablesAgentAction } from '../platform/tables/agent-adapter.js';

const filterClauseSchema = z.object({
  fieldId: z.number().int().positive().describe('Stable numeric field ID from schema.get.'),
  operator: z
    .enum(['eq', 'neq', 'contains', 'not_contains', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty', 'in'])
    .describe('Type-compatible filter operator.'),
  value: z.unknown().optional().describe('Filter value; omitted for is_empty/is_not_empty.'),
});

export const tableQuerySchema = z.object({
  where: z
    .object({
      combinator: z.enum(['and', 'or']).describe('How clauses are combined.'),
      clauses: z.array(filterClauseSchema).max(20).describe('At most 20 field clauses.'),
    })
    .optional()
    .describe('Bounded field filter group.'),
  search: z.string().max(200).optional().describe('Case-insensitive text/long-text search.'),
  sort: z
    .array(
      z.object({
        fieldId: z.number().int().positive().optional().describe('Dynamic field ID.'),
        systemField: z.enum(['created_at', 'updated_at']).optional().describe('Record system timestamp.'),
        direction: z.enum(['asc', 'desc']).describe('Sort direction.'),
      }),
    )
    .max(3)
    .optional()
    .describe('At most three sort keys.'),
  cursor: z.string().optional().describe('Opaque cursor returned by the previous records.query call.'),
  limit: z.number().int().min(1).max(500).optional().describe('Page size, default 50 and maximum 500.'),
});

const tablesQuerySchema = z.object({
  action: z
    .enum([
      'bases.list',
      'base.get',
      'tables.list',
      'schema.get',
      'records.get',
      'records.query',
      'records.aggregate',
      'dashboards.list',
      'dashboard.get',
    ])
    .describe('Read action to execute.'),
  base_id: z.number().int().positive().optional().describe('Base ID for base/tables/dashboards actions.'),
  table_id: z.number().int().positive().optional().describe('Table ID for schema and record actions.'),
  record_id: z.number().int().positive().optional().describe('Record ID for records.get.'),
  dashboard_id: z.number().int().positive().optional().describe('Dashboard ID for dashboard.get.'),
  search: z.string().max(200).optional().describe('Base name search for bases.list.'),
  query: tableQuerySchema.optional().describe('Bounded record query for records.query/aggregate.'),
  operation: z.enum(['count', 'sum', 'avg', 'min', 'max']).optional().describe('Aggregate operation.'),
  value_field_id: z.number().int().positive().optional().describe('Numeric field for sum/avg/min/max.'),
  group_by_field_id: z.number().int().positive().optional().describe('Optional grouping field.'),
  aggregate_limit: z.number().int().min(1).max(100).optional().describe('Maximum aggregate groups.'),
});

type TablesQueryInput = z.infer<typeof tablesQuerySchema>;

export interface TablesQueryContext {
  userId: string;
}

const meta: ToolMeta = {
  id: 'tables_query',
  name: 'Tables Query',
  brief: 'Read internal multidimensional tables',
  description: `Read-only access to the internal Tables application.

Use bases.list to discover Base IDs, tables.list/schema.get to discover stable table/field IDs, then records.get/records.query/records.aggregate for data. Queries accept only the bounded JSON filter/sort AST; raw SQL, JavaScript, formula strings, and schema mutations are not supported. Results always respect the bound user's Platform permissions and Base membership.

A Base's or table's "description" is the team's usage note — what the data is, which field is the key, what values mean. Read it before you query or write; when it is empty, ask rather than infer meaning from field names.`,
  category: 'team',
  is_global: false,
  surface: { proxy: 'read', mcp: 'tables', workbench: true, unattendedReplaySafe: true },
  icon: 'Table2',
  sort_order: 28,
};

export function createTablesQueryTool(ctx: TablesQueryContext) {
  return tool({
    description: meta.description,
    inputSchema: tablesQuerySchema,
    execute: async (input: TablesQueryInput) => {
      const context = { userId: ctx.userId };
      if (input.action === 'bases.list') {
        const result = await dispatchTablesAgentAction(context, 'listBases', { search: input.search });
        return result.ok ? result.data : { error: result.message };
      }
      if (input.action === 'base.get') {
        if (!input.base_id) return { error: 'base_id is required' };
        const result = await dispatchTablesAgentAction(
          context,
          'getBase',
          { baseId: input.base_id },
          { baseId: input.base_id },
        );
        return result.ok ? result.data : { error: result.message };
      }
      if (input.action === 'tables.list') {
        if (!input.base_id) return { error: 'base_id is required' };
        const result = await dispatchTablesAgentAction(
          context,
          'listTables',
          { baseId: input.base_id },
          { baseId: input.base_id },
        );
        return result.ok ? result.data : { error: result.message };
      }
      if (input.action === 'schema.get') {
        if (!input.table_id) return { error: 'table_id is required' };
        const result = await dispatchTablesAgentAction(
          context,
          'getSchema',
          { tableId: input.table_id },
          { tableId: input.table_id },
        );
        return result.ok ? result.data : { error: result.message };
      }
      if (input.action === 'records.get') {
        if (!input.table_id || !input.record_id) return { error: 'table_id and record_id are required' };
        const result = await dispatchTablesAgentAction(
          context,
          'getRecord',
          { tableId: input.table_id, recordId: input.record_id },
          { tableId: input.table_id, recordId: input.record_id },
        );
        return result.ok ? result.data : { error: result.message };
      }
      if (input.action === 'records.query') {
        if (!input.table_id) return { error: 'table_id is required' };
        const result = await dispatchTablesAgentAction(
          context,
          'queryRecords',
          { tableId: input.table_id, query: input.query ?? {} },
          { tableId: input.table_id },
        );
        return result.ok ? result.data : { error: result.message };
      }
      if (input.action === 'records.aggregate') {
        if (!input.table_id) return { error: 'table_id is required' };
        const result = await dispatchTablesAgentAction(
          context,
          'aggregateRecords',
          {
            tableId: input.table_id,
            input: {
              operation: input.operation ?? 'count',
              valueFieldId: input.value_field_id,
              groupByFieldId: input.group_by_field_id,
              query: input.query,
              limit: input.aggregate_limit,
            },
          },
          { tableId: input.table_id },
        );
        return result.ok ? result.data : { error: result.message };
      }
      if (input.action === 'dashboards.list') {
        if (!input.base_id) return { error: 'base_id is required' };
        const result = await dispatchTablesAgentAction(
          context,
          'listDashboards',
          { baseId: input.base_id },
          { baseId: input.base_id },
        );
        return result.ok ? result.data : { error: result.message };
      }
      if (!input.dashboard_id) return { error: 'dashboard_id is required' };
      const result = await dispatchTablesAgentAction(
        context,
        'getDashboard',
        { dashboardId: input.dashboard_id },
        { dashboardId: input.dashboard_id },
      );
      return result.ok ? result.data : { error: result.message };
    },
  });
}

export const tablesQueryTool = defineTool({ meta, kind: 'lazy' });
