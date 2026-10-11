/**
 * `tables_query builder.reference {topic}` — compact JSON that teaches the
 * config grammar of `tables_schema_plan` (spec §9). It lives behind a read
 * action instead of in a tool description, so it costs nothing until the model
 * asks for it.
 *
 * Every example is a real plan operation that builds on `PLAN_EXAMPLE` (a
 * small CRM Base declared with refs), and a test drafts the example plan plus
 * every topic's operations through the real validators — an example the
 * server would refuse cannot ship.
 */

import {
  SCHEMA_PLAN_REF_KINDS,
  TABLE_AUTOMATION_TRIGGERS,
  TABLE_AUTOMATION_VALUE_TOKENS,
  TABLE_FILTER_OPERATORS,
  TABLE_FORM_DEFAULT_TOKENS,
  TABLE_FORMULA_BINARY_OPERATORS,
  TABLE_FORMULA_FUNCTIONS,
  TABLE_SYSTEM_FIELDS,
  TABLE_VIEW_TYPES,
  type SchemaPlanOperation,
} from '@greenhouse/types/tables';
import { TABLE_CARD_KINDS } from '@greenhouse/types/table-cards';
import { APP_ACCENTS, APP_CARD_KINDS, APP_ICONS, APP_LIMITS } from '@greenhouse/types/apps';

export const BUILDER_REFERENCE_TOPICS = ['plan', 'view', 'form', 'automation', 'dashboard', 'role', 'app'] as const;
export type BuilderReferenceTopic = (typeof BUILDER_REFERENCE_TOPICS)[number];

/** Ids an example uses for existing people / groups — in a real plan they come from directory.search. */
export const EXAMPLE_USER_ID = 'u_1f2e3d';
export const EXAMPLE_GROUP_ID = 7;

/** A whole small Base from one plan: the refs every other example points at. */
export const PLAN_EXAMPLE: SchemaPlanOperation[] = [
  {
    op: 'base.create',
    ref: 'crm',
    name: 'Sales CRM',
    description: 'Deals and their follow-ups. One row per deal; Stage drives the pipeline board.',
    defaultTableRef: 'deals',
    defaultTableName: 'Deals',
    primaryFieldRef: 'deal',
    primaryFieldName: 'Deal',
  },
  {
    op: 'field.create',
    ref: 'stage',
    tableRef: 'deals',
    name: 'Stage',
    type: 'single_select',
    config: {
      options: [
        { id: 'lead', label: 'Lead' },
        { id: 'won', label: 'Won' },
        { id: 'lost', label: 'Lost' },
      ],
    },
  },
  { op: 'field.create', ref: 'owner', tableRef: 'deals', name: 'Owner', type: 'user' },
  { op: 'field.create', ref: 'amount', tableRef: 'deals', name: 'Amount', type: 'number' },
  { op: 'field.create', ref: 'close', tableRef: 'deals', name: 'Close date', type: 'date' },
  { op: 'field.create', ref: 'notes', tableRef: 'deals', name: 'Notes', type: 'long_text' },
  {
    op: 'field.create',
    ref: 'size',
    tableRef: 'deals',
    name: 'Size',
    type: 'formula',
    config: {
      formula: {
        resultType: 'text',
        expression: {
          type: 'function',
          name: 'if',
          args: [
            {
              type: 'binary',
              operator: 'gt',
              left: { type: 'field', fieldId: '$field:amount' },
              right: { type: 'literal', value: 10000 },
            },
            { type: 'literal', value: 'Large' },
            { type: 'literal', value: 'Small' },
          ],
        },
      },
    },
  },
];

const TOPIC_OPERATIONS: Readonly<Record<Exclude<BuilderReferenceTopic, 'plan'>, SchemaPlanOperation[]>> = {
  view: [
    {
      op: 'view.create',
      ref: 'pipeline',
      tableRef: 'deals',
      name: 'Pipeline',
      type: 'kanban',
      config: { kanban: { groupFieldId: '$field:stage' }, fieldIds: ['$field:owner', '$field:amount'] },
    },
    {
      op: 'view.create',
      tableRef: 'deals',
      name: 'Closing',
      type: 'calendar',
      config: { calendar: { startFieldId: '$field:close' } },
    },
    {
      op: 'view.create',
      tableRef: 'deals',
      name: 'My open deals',
      config: {
        query: {
          where: {
            combinator: 'and',
            clauses: [
              { fieldId: '$field:owner', operator: 'eq', value: '$me' },
              { fieldId: '$field:stage', operator: 'neq', value: 'won' },
            ],
          },
          sort: [{ fieldId: '$field:close', direction: 'asc' }],
        },
        groupBy: { fieldId: '$field:stage' },
        widths: { '$field:notes': 320 },
      },
    },
  ],
  form: [
    {
      op: 'form.create',
      ref: 'intake',
      tableRef: 'deals',
      name: 'New lead',
      status: 'published',
      audience: { type: 'team' },
      config: {
        title: 'Tell us about a lead',
        fieldIds: ['$field:amount', '$field:notes'],
        defaults: [
          { fieldId: '$field:stage', value: 'lead' },
          { fieldId: '$field:owner', value: '$me' },
        ],
        successMessage: 'Thanks — sales will follow up.',
        allowMultiple: true,
      },
    },
  ],
  automation: [
    {
      op: 'automation.create',
      ref: 'won',
      tableRef: 'deals',
      name: 'Deal won',
      trigger: 'record_updated',
      status: 'enabled',
      config: {
        watchFieldIds: ['$field:stage'],
        condition: { combinator: 'and', clauses: [{ fieldId: '$field:stage', operator: 'eq', value: 'won' }] },
        actions: [
          { type: 'update_record', values: [{ fieldId: '$field:close', value: '$today' }] },
          {
            type: 'notify',
            recipients: { userFieldIds: ['$field:owner'], groupIds: [EXAMPLE_GROUP_ID] },
            title: 'Deal won',
            message: 'Notes: {{field:$field:notes}}',
            channels: ['inbox', 'im'],
          },
        ],
      },
    },
    {
      op: 'automation.create',
      tableRef: 'deals',
      name: 'Closes tomorrow',
      trigger: 'date_reached',
      status: 'enabled',
      config: {
        dateTrigger: { fieldId: '$field:close', offsetDays: -1, time: '09:00', timezone: 'Asia/Shanghai' },
        actions: [
          {
            type: 'notify',
            recipients: { userFieldIds: ['$field:owner'] },
            title: 'A deal closes tomorrow',
            message: 'Check the deal before it closes.',
          },
        ],
      },
    },
    {
      op: 'automation.create',
      tableRef: 'deals',
      name: 'Mark lost',
      trigger: 'button',
      status: 'enabled',
      config: {
        buttonLabel: 'Mark lost',
        actions: [{ type: 'update_record', values: [{ fieldId: '$field:stage', value: 'lost' }] }],
      },
    },
    {
      op: 'automation.create',
      tableRef: 'deals',
      name: 'Weekly review row',
      trigger: 'schedule',
      config: {
        schedule: { cron: '0 9 * * 1', timezone: 'Asia/Shanghai', scope: 'once' },
        actions: [
          {
            type: 'create_record',
            tableId: '$table:deals',
            values: [{ fieldId: '$field:notes', value: 'Weekly pipeline review' }],
          },
        ],
      },
    },
  ],
  dashboard: [
    {
      op: 'dashboard.create',
      ref: 'overview',
      baseRef: 'crm',
      name: 'Overview',
      config: {
        version: 1,
        filters: [
          {
            id: 'period',
            label: 'Close date',
            kind: 'date_range',
            targets: [{ tableId: '$table:deals', fieldId: '$field:close' }],
          },
        ],
      },
    },
    {
      op: 'widget.create',
      dashboardRef: 'overview',
      title: 'Won this month',
      card: {
        kind: 'kpi',
        source: {
          tableId: '$table:deals',
          query: {
            where: {
              combinator: 'and',
              clauses: [
                { fieldId: '$field:stage', operator: 'eq', value: 'won' },
                { fieldId: '$field:close', operator: 'gte', value: '$month_start' },
              ],
            },
          },
        },
        aggregate: { operation: 'sum', valueFieldId: '$field:amount' },
      },
      layout: { x: 0, y: 0, w: 4, h: 3 },
    },
    {
      op: 'widget.create',
      dashboardRef: 'overview',
      title: 'Deals by month',
      card: {
        kind: 'chart',
        source: { tableId: '$table:deals' },
        aggregate: {
          operation: 'count',
          groupBy: { fieldId: '$field:close', dateBucket: 'month' },
          series: { fieldId: '$field:stage' },
        },
        chart: { type: 'bar', stacked: true },
      },
      layout: { x: 4, y: 0, w: 8, h: 4 },
    },
    {
      op: 'widget.create',
      dashboardRef: 'overview',
      title: 'Amount by owner and stage',
      card: {
        kind: 'pivot',
        source: { tableId: '$table:deals' },
        aggregate: {
          operation: 'sum',
          valueFieldId: '$field:amount',
          groupBy: { fieldId: '$field:owner' },
          series: { fieldId: '$field:stage' },
        },
      },
    },
    {
      op: 'widget.create',
      dashboardRef: 'overview',
      title: 'Largest deals',
      card: {
        kind: 'records',
        source: { tableId: '$table:deals', query: { sort: [{ fieldId: '$field:amount', direction: 'desc' }] } },
        fieldIds: ['$field:amount', '$field:owner', '$field:stage'],
        limit: 10,
      },
    },
    {
      op: 'widget.create',
      dashboardRef: 'overview',
      title: 'How to read this',
      card: { kind: 'text', markdown: 'Amounts are in CNY. **Won** deals count on their close date.' },
    },
  ],
  role: [
    {
      op: 'role.create',
      ref: 'sales',
      baseRef: 'crm',
      name: 'Sales rep',
      description: 'Own deals only; amounts read-only.',
      rules: {
        version: 1,
        dashboards: 'all',
        tables: [
          {
            tableId: '$table:deals',
            access: 'edit',
            rows: { type: 'related', creator: true, fieldIds: ['$field:owner'] },
            fields: [{ fieldId: '$field:amount', access: 'read' }],
            fieldDefault: 'visible',
            create: true,
            delete: false,
          },
        ],
      },
    },
    {
      op: 'member.set',
      baseRef: 'crm',
      principal: 'group',
      groupId: EXAMPLE_GROUP_ID,
      role: 'custom',
      roleRef: 'sales',
    },
    { op: 'member.set', baseRef: 'crm', principal: 'user', userId: EXAMPLE_USER_ID, role: 'editor' },
    { op: 'base.update', baseRef: 'crm', visibility: 'team', teamRole: 'viewer' },
  ],
  app: [
    // A one-step approval needs a status, who decided, when, and why not.
    {
      op: 'field.create',
      ref: 'approval',
      tableRef: 'deals',
      name: 'Discount approval',
      type: 'single_select',
      config: {
        options: [
          { id: 'pending', label: 'Pending' },
          { id: 'approved', label: 'Approved' },
          { id: 'rejected', label: 'Rejected' },
        ],
      },
    },
    { op: 'field.create', ref: 'approver', tableRef: 'deals', name: 'Approved by', type: 'user' },
    { op: 'field.create', ref: 'approved_at', tableRef: 'deals', name: 'Decided at', type: 'datetime' },
    { op: 'field.create', ref: 'reason', tableRef: 'deals', name: 'Reject reason', type: 'long_text' },
    {
      op: 'app.create',
      ref: 'desk',
      baseRef: 'crm',
      name: 'Discount desk',
      icon: 'check',
      accent: 'teal',
      spec: {
        version: 1,
        home: 'mine',
        pages: [
          {
            id: 'mine',
            title: 'My requests',
            icon: 'inbox',
            cards: [
              {
                id: 'list',
                kind: 'records',
                title: 'My requests',
                layout: { x: 0, y: 0, w: 8, h: 6 },
                source: {
                  tableId: '$table:deals',
                  query: {
                    where: {
                      combinator: 'and',
                      clauses: [{ systemField: 'created_by', operator: 'eq', value: '$me' }],
                    },
                  },
                },
                fieldIds: ['$field:deal', '$field:amount', '$field:approval'],
                detail: {
                  fieldIds: ['$field:deal', '$field:amount', '$field:notes', '$field:approval', '$field:reason'],
                  comments: true,
                },
              },
              {
                id: 'ask',
                kind: 'form',
                title: 'Ask for a discount',
                layout: { x: 8, y: 0, w: 4, h: 6 },
                tableId: '$table:deals',
                fieldIds: ['$field:deal', '$field:amount', '$field:notes'],
                defaults: [
                  { fieldId: '$field:approval', value: 'pending' },
                  { fieldId: '$field:owner', value: '$me' },
                ],
              },
            ],
          },
          {
            id: 'review',
            title: 'To review',
            icon: 'check',
            cards: [
              {
                id: 'board',
                kind: 'kanban',
                layout: { x: 0, y: 0, w: 12, h: 8 },
                source: { tableId: '$table:deals' },
                groupFieldId: '$field:approval',
                fieldIds: ['$field:deal', '$field:amount', '$field:owner'],
                actions: [
                  {
                    id: 'approve',
                    label: 'Approve',
                    roles: ['manager'],
                    when: {
                      combinator: 'and',
                      clauses: [
                        { fieldId: '$field:approval', operator: 'eq', value: 'pending' },
                        { systemField: 'created_by', operator: 'neq', value: '$me' },
                      ],
                    },
                    do: {
                      type: 'set_fields',
                      values: [
                        { fieldId: '$field:approval', value: 'approved' },
                        { fieldId: '$field:approver', value: '$me' },
                        { fieldId: '$field:approved_at', value: '$now' },
                      ],
                    },
                  },
                  {
                    id: 'reject',
                    label: 'Reject',
                    roles: ['manager'],
                    when: {
                      combinator: 'and',
                      clauses: [{ fieldId: '$field:approval', operator: 'eq', value: 'pending' }],
                    },
                    do: {
                      type: 'set_fields',
                      values: [{ fieldId: '$field:approval', value: 'rejected' }],
                      inputFieldIds: ['$field:reason'],
                      requiredInputFieldIds: ['$field:reason'],
                    },
                  },
                ],
              },
            ],
          },
          {
            id: 'stats',
            title: 'Stats',
            icon: 'chart',
            cards: [
              {
                id: 'approved',
                kind: 'kpi',
                title: 'Approved amount',
                layout: { x: 0, y: 0, w: 4, h: 3 },
                card: {
                  kind: 'kpi',
                  source: {
                    tableId: '$table:deals',
                    query: {
                      where: {
                        combinator: 'and',
                        clauses: [{ fieldId: '$field:approval', operator: 'eq', value: 'approved' }],
                      },
                    },
                  },
                  aggregate: { operation: 'sum', valueFieldId: '$field:amount' },
                },
              },
            ],
          },
        ],
        roles: [
          {
            key: 'rep',
            name: 'Sales rep',
            pages: ['mine'],
            canComment: true,
            tables: [
              {
                tableId: '$table:deals',
                access: 'edit',
                rows: { type: 'related', creator: true, fieldIds: [] },
                editRows: {
                  type: 'where',
                  where: {
                    combinator: 'and',
                    clauses: [{ fieldId: '$field:approval', operator: 'eq', value: 'pending' }],
                  },
                },
                fields: [
                  { fieldId: '$field:approval', access: 'read' },
                  { fieldId: '$field:approver', access: 'read' },
                  { fieldId: '$field:approved_at', access: 'read' },
                  { fieldId: '$field:reason', access: 'read' },
                ],
                fieldDefault: 'visible',
                create: true,
              },
            ],
          },
          {
            key: 'manager',
            name: 'Manager',
            pages: 'all',
            canComment: true,
            tables: [{ tableId: '$table:deals', access: 'edit', fields: [], fieldDefault: 'visible' }],
          },
        ],
      },
    },
    {
      op: 'app.audience',
      appRef: 'desk',
      entries: [
        { principal: { type: 'team' }, roleKey: 'rep' },
        { principal: { type: 'group', groupId: EXAMPLE_GROUP_ID }, roleKey: 'manager' },
      ],
    },
    { op: 'app.publish', appRef: 'desk', notes: 'First version' },
  ],
};

const SHARED_NOTES = [
  `Examples build on the plan example (builder.reference topic=plan): "$field:stage" etc. are refs it declares. Use real ids for existing objects.`,
];

const TOPIC_NOTES: Readonly<Record<Exclude<BuilderReferenceTopic, 'plan'>, string[]>> = {
  view: [
    `type: ${TABLE_VIEW_TYPES.join(' | ')}. kanban.groupFieldId = single_select or user field; calendar.startFieldId (+ optional endFieldId) = date / datetime; gallery.coverFieldId = attachment.`,
    'config keys: fieldIds (visible columns, in order), systemFields, widths {fieldId: px}, frozenCount, rowHeight short|medium|tall, query {where, filters, sort, search}, groupBy {fieldId|systemField} (grid).',
    `filter clause: {fieldId|systemField, operator, value}. operators: ${TABLE_FILTER_OPERATORS.join(', ')}. systemField: ${TABLE_SYSTEM_FIELDS.join(', ')}. Tokens: $me (person clauses), $today, $today-7d, $today+3d, $now, $week_start, $month_start (date clauses).`,
    'view.update replaces the whole config and needs the revision from schema.get views.',
  ],
  form: [
    'Forms are submit-only: submitters never see records. status published = open; draft = closed.',
    'audience: {type:"base"} (Base members who can create) | {type:"team"} (every internal user) | {type:"principals", userIds, groupIds} (ids from directory.search).',
    `config: fieldIds (shown, writable, never formula/rollup/lookup; relation only for base audience), defaults [{fieldId, value}] (hidden and locked; tokens ${TABLE_FORM_DEFAULT_TOKENS.join(', ')}), allowMultiple, title, description, submitLabel, successMessage. A field is shown or prefilled, never both.`,
  ],
  automation: [
    `trigger: ${TABLE_AUTOMATION_TRIGGERS.join(' | ')}. record_matched needs condition; schedule needs schedule {cron, timezone, scope once|records} (≥ 15 min apart); date_reached needs dateTrigger; button needs buttonLabel; record_updated may set watchFieldIds.`,
    'actions (1-10): update_record {values:[{fieldId, value}]}, create_record {tableId, values}, notify {recipients {userIds, groupIds, userFieldIds, creator, actor}, title, message, channels inbox|im|email, urgent}, delay {minutes 1-1440}.',
    `values may use ${TABLE_AUTOMATION_VALUE_TOKENS.join(', ')}; text may embed {{field:<fieldId>}} (in a plan: {{field:$field:<ref>}}). condition is a filter group (see topic=view).`,
    'No webhook actions in a plan — a person adds those in the editor. The rule runs as whoever confirms the plan; it starts disabled unless status is enabled.',
  ],
  dashboard: [
    'dashboard.config: {version:1, filters:[{id, label, kind date_range|select|user|search, targets:[{tableId, fieldId}]}]}.',
    `widget card kind: ${TABLE_CARD_KINDS.join(' | ')}. kpi/chart/pivot: aggregate {operation count|sum|avg|min|max, valueFieldId, groupBy {fieldId|systemField, dateBucket day|week|month|quarter|year}, series {fieldId}, sort, limit}; pivot needs groupBy; chart {type bar|line|area|pie, stacked, horizontal, donut}; records: fieldIds, limit; text: markdown.`,
    'layout {x, y, w 1-24, h 1-24}. widget.update / widget.delete name the dashboardId and the widget id from dashboard.get.',
  ],
  role: [
    'Custom roles: rules {version:1, dashboards all|none, tables:[{tableId, access read|edit, rows, editRows?, fields:[{fieldId, access hidden|read|edit}], fieldDefault visible|hidden, create?, delete?}]}. A table without a rule is invisible to the role.',
    'rows: {type:"all"} | {type:"related", creator, fieldIds (person fields that include the viewer)} | {type:"where", where: filter group}.',
    'member.set: principal user (userId) or group (groupId), role builder|editor|viewer|custom (roleRef or customRoleId)|none (removes). Groups are never builder. Ids from directory.search; roles.list shows existing roles.',
    'base.update sets visibility private|team and teamRole viewer|editor|custom (roleRef). Roles and access need the Base owner.',
  ],
  app: [
    `spec {version:1, pages (1-${APP_LIMITS.pages}), roles (1-${APP_LIMITS.roles}), home?, nav? {layout tabs|sidebar}} over ONE Base. Ids: lowercase a-z 0-9 _ - (≤40), unique in scope; no page "edit".`,
    `page {id, title, icon?, filters? (dashboard filter controls), cards}. card {id, title?, layout {x, y, w, h 1-24}, kind ${APP_CARD_KINDS.join('|')}}: records {source {tableId, query?}, fieldIds, detail?, create? {fieldIds, defaults?}, actions?}; kanban {source, groupFieldId, fieldIds, actions?, move?}; calendar {source, startFieldId, fieldIds}; gallery {source, coverFieldId?, fieldIds}; form {tableId, fieldIds, defaults?}; kpi|chart|pivot {card: topic=dashboard}; text {markdown}; buttons {buttons [{id, label, type open_page|open_url|create_record}]}.`,
    'detail {fieldIds, editableFieldIds?, actions?, comments?}. action {id, label, roles?, when? (re-checked in the write), confirm?, do: set_fields {values ($me/$now/$today), inputFieldIds?, requiredInputFieldIds?} | run_automation {ruleId: a button rule} | delete}. set_fields keys must be editable for every role the action applies to.',
    'Approval = one step per action (when pending AND created_by ≠ $me). Multi-level, parallel or routed approvals are NOT supported — never promise them. "Mine": {systemField:"created_by", operator:"eq", value:"$me"}; a page filter is "$page.<filterId>" in a clause value.',
    'role {key, name, pages "all"|[ids], tables [rules as topic=role], canComment?} — all a viewer gets; they need not be Base members.',
    `icon ${APP_ICONS.join('|')}; accent ${APP_ACCENTS.join('|')}. app.create makes a DRAFT; app.update {appId|appRef, draftRevision, spec?, name?} replaces it; app.audience / app.publish need the Base owner. Existing apps: tables_query apps.list / apps.get.`,
  ],
};

const PLAN_NOTES = [
  'Operations apply in order. Every *.create may carry a ref (letters, digits, _ -; one namespace per plan).',
  'Point at a ref with tableRef / baseRef / dashboardRef / roleRef, or anywhere in a config (value or object key) with the string "$<kind>:<ref>".',
  `ref kinds in configs: ${SCHEMA_PLAN_REF_KINDS.join(', ')}.`,
  'Updates name the existing id and the revision you read (field/table/base updates have no revision). Nothing is deleted except widgets (widget.delete) and grants (member.set role none).',
  'Ops: base.create|update, table.create|update, field.create|update|archive, view.create|update, form.create|update, automation.create|update, dashboard.create|update, widget.create|update|delete, role.create|update, member.set, app.create|update|audience|publish (topic=app).',
  'Every new table has a required primary text field "Name": rename it with primaryFieldName and point at it with primaryFieldRef (base.create / table.create) — forms and app cards usually need it.',
  `formula AST: {type:"literal",value} | {type:"field",fieldId} | {type:"binary",operator,left,right} | {type:"function",name,args}. operators: ${TABLE_FORMULA_BINARY_OPERATORS.join(', ')}. functions: ${TABLE_FORMULA_FUNCTIONS.join(', ')}.`,
];

/** The reference for one topic, as returned by `tables_query builder.reference`. */
export function builderReference(topic: BuilderReferenceTopic) {
  if (topic === 'plan') return { topic, notes: PLAN_NOTES, example: PLAN_EXAMPLE };
  return { topic, notes: [...TOPIC_NOTES[topic], ...SHARED_NOTES], examples: TOPIC_OPERATIONS[topic] };
}

/** Every example operation of every topic, after the plan example (what the reference test drafts). */
export function allReferenceOperations(): SchemaPlanOperation[] {
  return [...PLAN_EXAMPLE, ...Object.values(TOPIC_OPERATIONS).flat()];
}
