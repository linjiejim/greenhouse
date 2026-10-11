/**
 * Tables Query — bounded read access for chat, Agent Proxy, and MCP.
 *
 * Besides data it reads what `tables_schema_plan` needs to draft against:
 * forms, automations (webhook targets reduced to their host, never secrets),
 * runs, roles (Base owner only — the handler decides), record activity, the
 * people and groups the caller may share with, `builder.reference` — the
 * config grammar as compact examples, so it costs no description budget — and
 * the apps built on a Base (`apps.list`; `apps.get` = a manager's draft, with
 * who it is shared with: what `app.update` / `app.audience` revise).
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getDb } from '@greenhouse/db';
import type { AppListView, AppSummary } from '@greenhouse/types/apps';
import { defineTool, type ToolMeta } from './define.js';
import { dispatchTablesAgentAction } from '../platform/tables/agent-adapter.js';
import { BUILDER_REFERENCE_TOPICS, builderReference } from '../platform/tables/builder-reference.js';
import { grantableGroups } from '../platform/tables/directory.js';
import { webhookDisplayUrl } from '../platform/tables/schema-plan.js';

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
      'forms.list',
      'automations.list',
      'automations.runs',
      'roles.list',
      'records.activity',
      'directory.search',
      'builder.reference',
      'apps.list',
      'apps.get',
    ])
    .describe('Read action to execute.'),
  base_id: z.number().int().positive().optional().describe('Base ID for base/tables/dashboards actions.'),
  table_id: z.number().int().positive().optional().describe('Table ID for schema and record actions.'),
  record_id: z.number().int().positive().optional().describe('Record ID for records.get / records.activity.'),
  dashboard_id: z.number().int().positive().optional().describe('Dashboard ID for dashboard.get.'),
  automation_id: z.number().int().positive().optional().describe('Automation ID for automations.runs.'),
  app_id: z.number().int().positive().optional().describe('App ID for apps.get (apps.list, optional base_id).'),
  search: z.string().max(200).optional().describe('Name search for bases.list and directory.search.'),
  topic: z
    .enum(BUILDER_REFERENCE_TOPICS)
    .optional()
    .describe('builder.reference: config grammar and examples for tables_schema_plan.'),
  cursor: z.string().max(500).optional().describe('records.activity: the nextCursor of the previous page.'),
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

const DIRECTORY_LIMIT = 20;

const meta: ToolMeta = {
  id: 'tables_query',
  name: 'Tables Query',
  brief: 'Read internal multidimensional tables',
  description: `Read-only access to the internal Tables application.

Use bases.list to discover Base IDs, tables.list/schema.get to discover stable table/field IDs, then records.get/records.query/records.aggregate for data. Queries accept only the bounded JSON filter/sort AST; raw SQL, JavaScript, formula strings, and schema mutations are not supported. Results always respect the bound user's Platform permissions and Base membership.

A Base's or table's "description" is the team's usage note — what the data is, which field is the key, what values mean. Read it before you query or write; when it is empty, ask rather than infer meaning from field names.

Before drafting tables_schema_plan: builder.reference {topic} shows each config's JSON, directory.search finds the people and groups you may share with.`,
  category: 'team',
  is_global: false,
  surface: { proxy: 'read', mcp: 'tables', workbench: true, unattendedReplaySafe: true },
  icon: 'Table2',
  sort_order: 28,
};

/** A webhook target reduced to its origin: a URL can carry a token, and secrets never leave the server. */
function redactWebhooks(data: unknown): unknown {
  const automations = (data as { automations?: unknown } | undefined)?.automations;
  if (!Array.isArray(automations)) return data;
  return {
    automations: automations.map((rule: { config?: { actions?: unknown } }) => {
      const actions = rule.config?.actions;
      if (!Array.isArray(actions)) return rule;
      return {
        ...rule,
        config: {
          ...rule.config,
          actions: actions.map((action: { type?: unknown; url?: unknown }) => {
            if (action.type !== 'webhook' || typeof action.url !== 'string') return action;
            return { ...action, url: webhookDisplayUrl(action.url) };
          }),
        },
      };
    }),
  };
}

/** `listRoles` minus the rule-editor facts (fields come from schema.get). */
function rolesOnly(data: unknown): unknown {
  const { roles, references } = (data ?? {}) as { roles?: unknown; references?: unknown };
  return { roles, references };
}

/** `listApps` narrowed to one Base: the apps the caller manages there and the ones shared with them. */
function appsOfBase(baseId: number | undefined) {
  return (data: unknown) => {
    const view = data as AppListView;
    const keep = (apps: AppSummary[] | undefined) =>
      (apps ?? []).filter((app) => baseId === undefined || app.baseId === baseId);
    return { managed: keep(view.managed), shared: keep(view.shared) };
  };
}

/** Active internal people and the groups the caller may grant, matching `search` (name / email). */
async function searchDirectory(userId: string, search: string | undefined) {
  const needle = (search ?? '').trim().toLowerCase();
  const matches = (...texts: Array<string | undefined>) =>
    !needle || texts.some((text) => text?.toLowerCase().includes(needle));
  const listed = await dispatchTablesAgentAction({ userId }, 'listAssignableUsers', {});
  if (!listed.ok) return { error: listed.message };
  const users = ((listed.data as { users?: Array<{ id: string; nickname: string; email: string }> }).users ?? [])
    .filter((user) => matches(user.nickname, user.email))
    .slice(0, DIRECTORY_LIMIT)
    .map((user) => ({ id: user.id, name: user.nickname, email: user.email }));
  const db = getDb();
  const groups = await Promise.all(
    (await grantableGroups(db, userId))
      .filter((group) => matches(group.name))
      .slice(0, DIRECTORY_LIMIT)
      .map(async (group) => ({ ...group, memberCount: (await db.groups.listMembers(group.id)).length })),
  );
  return { users, groups };
}

export function createTablesQueryTool(ctx: TablesQueryContext) {
  return tool({
    description: meta.description,
    inputSchema: tablesQuerySchema,
    execute: async (input: TablesQueryInput) => {
      const context = { userId: ctx.userId };
      const run = async (
        action: Parameters<typeof dispatchTablesAgentAction>[1],
        payload: unknown,
        ids: Parameters<typeof dispatchTablesAgentAction>[3],
        shape: (data: unknown) => unknown = (data) => data,
      ) => {
        const result = await dispatchTablesAgentAction(context, action, payload, ids);
        return result.ok ? shape(result.data) : { error: result.message };
      };
      const baseId = input.base_id;
      const tableId = input.table_id;
      switch (input.action) {
        case 'bases.list':
          return run('listBases', { search: input.search }, {});
        case 'base.get':
          if (!baseId) return { error: 'base_id is required' };
          return run('getBase', { baseId }, { baseId });
        case 'tables.list':
          if (!baseId) return { error: 'base_id is required' };
          return run('listTables', { baseId }, { baseId });
        case 'schema.get':
          if (!tableId) return { error: 'table_id is required' };
          return run('getSchema', { tableId }, { tableId });
        case 'records.get':
          if (!tableId || !input.record_id) return { error: 'table_id and record_id are required' };
          return run('getRecord', { tableId, recordId: input.record_id }, { tableId, recordId: input.record_id });
        case 'records.query':
          if (!tableId) return { error: 'table_id is required' };
          return run('queryRecords', { tableId, query: input.query ?? {} }, { tableId });
        case 'records.aggregate':
          if (!tableId) return { error: 'table_id is required' };
          return run(
            'aggregateRecords',
            {
              tableId,
              input: {
                operation: input.operation ?? 'count',
                valueFieldId: input.value_field_id,
                groupByFieldId: input.group_by_field_id,
                query: input.query,
                limit: input.aggregate_limit,
              },
            },
            { tableId },
          );
        case 'records.activity':
          if (!tableId || !input.record_id) return { error: 'table_id and record_id are required' };
          return run(
            'listRecordActivity',
            { tableId, recordId: input.record_id, cursor: input.cursor },
            { tableId, recordId: input.record_id },
          );
        case 'dashboards.list':
          if (!baseId) return { error: 'base_id is required' };
          return run('listDashboards', { baseId }, { baseId });
        case 'dashboard.get':
          if (!input.dashboard_id) return { error: 'dashboard_id is required' };
          return run('getDashboard', { dashboardId: input.dashboard_id }, { dashboardId: input.dashboard_id });
        case 'forms.list':
          if (!tableId) return { error: 'table_id is required' };
          return run('listForms', { tableId }, { tableId });
        case 'automations.list':
          if (!baseId) return { error: 'base_id is required' };
          return run('listAutomations', { baseId }, { baseId }, redactWebhooks);
        case 'automations.runs':
          if (!input.automation_id) return { error: 'automation_id is required' };
          return run(
            'listAutomationRuns',
            { automationId: input.automation_id },
            { automationId: input.automation_id },
          );
        case 'roles.list':
          if (!baseId) return { error: 'base_id is required' };
          return run('listRoles', { baseId }, { baseId }, rolesOnly);
        case 'directory.search':
          return searchDirectory(ctx.userId, input.search);
        case 'builder.reference':
          return builderReference(input.topic ?? 'plan');
        case 'apps.list':
          return run('listApps', {}, {}, appsOfBase(baseId));
        case 'apps.get': {
          const appId = input.app_id;
          if (!appId) return { error: 'app_id is required' };
          // Managers only: the draft (with today's schema problems) and who the app is shared with.
          const draft = await dispatchTablesAgentAction(context, 'getAppDraft', { appId }, { appId });
          if (!draft.ok) return { error: draft.message };
          const audiences = await dispatchTablesAgentAction(context, 'listAppAudiences', { appId }, { appId });
          return { ...(draft.data as object), audiences: audiences.ok ? audiences.data : null };
        }
      }
    },
  });
}

export const tablesQueryTool = defineTool({ meta, kind: 'lazy' });
