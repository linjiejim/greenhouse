/**
 * The in-memory Base the app-spec validator tests check against (shared by
 * app-spec.test.ts and the Phase 2 card tests in app-spec-advanced.test.ts):
 * one Base, a Requests table with a field of every kind the procurement app
 * uses, a table of another Base, and the procurement app of acceptance 1.
 */

import type { TableFieldRow, TablesSchemaSource } from '@greenhouse/db';
import type { AppCard, AppPage, AppSpec } from '@greenhouse/types/apps';
import type { TableAccessRule } from '@greenhouse/types/table-access';
import type { AppSpecSchema } from '../../app-spec.js';

export const NOW = '2026-10-11T00:00:00.000Z';
export const BASE = 1;
export const T = 10; // Requests
export const OTHER = 20; // a table of another Base

export const STATUS_OPTIONS = JSON.stringify({
  options: [
    { id: 'pending', label: 'Pending' },
    { id: 'approved', label: 'Approved' },
    { id: 'rejected', label: 'Rejected' },
  ],
});

export function fieldRow(
  id: number,
  name: string,
  type: TableFieldRow['type'],
  extra: Partial<TableFieldRow> = {},
): TableFieldRow {
  return {
    id,
    table_id: T,
    name,
    type,
    required: false,
    is_primary: false,
    config: '{}',
    position: id,
    created_by: 'u_owner',
    created_at: NOW,
    updated_at: NOW,
    archived_at: null,
    ...extra,
  };
}

export const F = {
  title: 100,
  amount: 101,
  status: 102,
  approver: 103,
  approvedAt: 104,
  reason: 105,
  doubled: 106,
  receipt: 107,
  due: 108,
} as const;

export function schema(options: { drop?: number[]; buttonRules?: AppSpecSchema['buttonRules'] } = {}): AppSpecSchema {
  const rows = [
    fieldRow(F.title, 'Title', 'text', { is_primary: true }),
    fieldRow(F.amount, 'Amount', 'number'),
    fieldRow(F.status, 'Status', 'single_select', { config: STATUS_OPTIONS }),
    fieldRow(F.approver, 'Approver', 'user'),
    fieldRow(F.approvedAt, 'Approved at', 'datetime'),
    fieldRow(F.reason, 'Reason', 'long_text'),
    fieldRow(F.doubled, 'Doubled', 'formula'),
    fieldRow(F.receipt, 'Receipt', 'attachment'),
    fieldRow(F.due, 'Due', 'date'),
  ].filter((row) => !options.drop?.includes(row.id));
  const source: TablesSchemaSource = {
    async table(tableId) {
      if (tableId === T) return { id: T, base_id: BASE, archived: false };
      if (tableId === OTHER) return { id: OTHER, base_id: 2, archived: false };
      return undefined;
    },
    async fields(tableId) {
      return tableId === T ? rows : [];
    },
    async activeUserIds() {
      return new Set(['u_owner', 'u_member']);
    },
    async existingGroupIds(ids) {
      return new Set(ids);
    },
  };
  return {
    baseId: BASE,
    facts: {
      tables: [{ id: T, name: 'Requests' }],
      fields: rows.map((row) => ({ id: row.id, tableId: T, type: row.type, name: row.name })),
      dependencies: [{ fieldId: F.doubled, dependsOnFieldId: F.amount }],
    },
    source,
    buttonRules: options.buttonRules ?? [{ id: 7, tableId: T }],
  };
}

export const layout = { x: 0, y: 0, w: 12, h: 6 };
export const editRule = (fields: TableAccessRule['fields'] = []): TableAccessRule => ({
  tableId: T,
  access: 'edit',
  fields,
  fieldDefault: 'visible',
  rows: { type: 'related', creator: true, fieldIds: [] },
});

/** The procurement app of acceptance criterion 1, reduced to what the validator sees. */
export function procurement(): AppSpec {
  return {
    version: 1,
    home: 'mine',
    nav: { layout: 'tabs' },
    pages: [
      {
        id: 'mine',
        title: 'My requests',
        icon: 'inbox',
        cards: [
          {
            id: 'list',
            kind: 'records',
            layout,
            source: {
              tableId: T,
              query: {
                where: { combinator: 'and', clauses: [{ systemField: 'created_by', operator: 'eq', value: '$me' }] },
              },
            },
            fieldIds: [F.title, F.amount, F.status],
            systemFields: ['created_at'],
            create: { fieldIds: [F.title, F.amount, F.receipt], defaults: [{ fieldId: F.status, value: 'pending' }] },
            detail: { fieldIds: [F.title, F.amount, F.status, F.receipt], comments: true },
          },
          {
            id: 'new',
            kind: 'form',
            layout,
            tableId: T,
            fieldIds: [F.title, F.amount, F.receipt],
            defaults: [{ fieldId: F.status, value: 'pending' }],
          },
        ],
      },
      {
        id: 'approve',
        title: 'Approvals',
        filters: [{ id: 'when', label: 'When', kind: 'date_range', targets: [{ tableId: T, fieldId: F.due }] }],
        cards: [
          {
            id: 'board',
            kind: 'kanban',
            layout,
            source: {
              tableId: T,
              query: {
                where: { combinator: 'and', clauses: [{ fieldId: F.due, operator: 'gte', value: '$page.when' }] },
              },
            },
            groupFieldId: F.status,
            fieldIds: [F.title, F.amount],
            actions: [
              {
                id: 'approve',
                label: 'Approve',
                roles: ['approver'],
                when: {
                  combinator: 'and',
                  clauses: [
                    { fieldId: F.status, operator: 'eq', value: 'pending' },
                    { systemField: 'created_by', operator: 'neq', value: '$me' },
                  ],
                },
                do: {
                  type: 'set_fields',
                  values: [
                    { fieldId: F.status, value: 'approved' },
                    { fieldId: F.approver, value: '$me' },
                    { fieldId: F.approvedAt, value: '$now' },
                  ],
                },
              },
              {
                id: 'reject',
                label: 'Reject',
                roles: ['approver'],
                do: {
                  type: 'set_fields',
                  values: [{ fieldId: F.status, value: 'rejected' }],
                  inputFieldIds: [F.reason],
                  requiredInputFieldIds: [F.reason],
                },
              },
              { id: 'notify', label: 'Notify', roles: ['approver'], do: { type: 'run_automation', ruleId: 7 } },
            ],
          },
        ],
      },
      {
        id: 'stats',
        title: 'Statistics',
        cards: [
          {
            id: 'monthly',
            kind: 'chart',
            layout,
            card: {
              kind: 'chart',
              source: { tableId: T },
              aggregate: { operation: 'sum', valueFieldId: F.amount, groupBy: { fieldId: F.due, dateBucket: 'month' } },
              chart: { type: 'bar' },
            },
          },
          { id: 'help', kind: 'text', layout, markdown: '**Totals** by month' },
          {
            id: 'links',
            kind: 'buttons',
            layout,
            buttons: [
              { id: 'go', label: 'My requests', type: 'open_page', pageId: 'mine' },
              { id: 'policy', label: 'Policy', type: 'open_url', url: 'https://example.com/policy' },
            ],
          },
        ],
      },
    ],
    roles: [
      { key: 'applicant', name: 'Applicant', pages: ['mine'], tables: [editRule()] },
      {
        key: 'approver',
        name: 'Approver',
        pages: 'all',
        tables: [{ tableId: T, access: 'edit', fields: [], fieldDefault: 'visible' }],
        canComment: true,
      },
    ],
  };
}

export function withPage(spec: AppSpec, index: number, change: (page: AppPage) => AppPage): AppSpec {
  return { ...spec, pages: spec.pages.map((page, i) => (i === index ? change(page) : page)) };
}

export function withCard(
  spec: AppSpec,
  pageIndex: number,
  cardIndex: number,
  change: (card: AppCard) => AppCard,
): AppSpec {
  return withPage(spec, pageIndex, (page) => ({
    ...page,
    cards: page.cards.map((card, i) => (i === cardIndex ? change(card) : card)),
  }));
}

export const paths = (result: { ok: boolean; errors?: Array<{ path: string }> }) =>
  'errors' in result && result.errors ? result.errors.map((error) => error.path) : [];
