/**
 * The app spec validator (apps spec §2, D6) against an in-memory Base: the
 * shape layer (ids, limits, cross-references, `$page` refs, links), the schema
 * layer (tables in the Base, fields and their types, queries through the db's
 * own card validator, `set_fields` keys editable for every role the action
 * applies to, `run_automation` = a button rule of the card's table) and the
 * runtime revalidation that turns problems into per-card / per-action issues.
 */

import { describe, expect, it } from 'vitest';
import type { TableFieldRow, TablesSchemaSource } from '@greenhouse/db';
import type { AppCard, AppPage, AppSpec } from '@greenhouse/types/apps';
import type { TableAccessRule } from '@greenhouse/types/table-access';
import { parseAppSpec, revalidateSpec, validateAppSpec, type AppSpecSchema } from '../app-spec.js';

const NOW = '2026-10-11T00:00:00.000Z';
const BASE = 1;
const T = 10; // Requests
const OTHER = 20; // a table of another Base

const STATUS_OPTIONS = JSON.stringify({
  options: [
    { id: 'pending', label: 'Pending' },
    { id: 'approved', label: 'Approved' },
    { id: 'rejected', label: 'Rejected' },
  ],
});

function fieldRow(
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

const F = {
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

function schema(options: { drop?: number[]; buttonRules?: AppSpecSchema['buttonRules'] } = {}): AppSpecSchema {
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

const layout = { x: 0, y: 0, w: 12, h: 6 };
const editRule = (fields: TableAccessRule['fields'] = []): TableAccessRule => ({
  tableId: T,
  access: 'edit',
  fields,
  fieldDefault: 'visible',
  rows: { type: 'related', creator: true, fieldIds: [] },
});

/** The procurement app of acceptance criterion 1, reduced to what the validator sees. */
function procurement(): AppSpec {
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

function withPage(spec: AppSpec, index: number, change: (page: AppPage) => AppPage): AppSpec {
  return { ...spec, pages: spec.pages.map((page, i) => (i === index ? change(page) : page)) };
}

function withCard(spec: AppSpec, pageIndex: number, cardIndex: number, change: (card: AppCard) => AppCard): AppSpec {
  return withPage(spec, pageIndex, (page) => ({
    ...page,
    cards: page.cards.map((card, i) => (i === cardIndex ? change(card) : card)),
  }));
}

const paths = (result: { ok: boolean; errors?: Array<{ path: string }> }) =>
  'errors' in result && result.errors ? result.errors.map((error) => error.path) : [];

describe('validateAppSpec — a valid app', () => {
  it('accepts the procurement app and returns embedded cards and filters normalized', async () => {
    const result = await validateAppSpec(procurement(), schema());
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const chart = result.spec.pages[2]!.cards[0]!;
    expect(chart.kind === 'chart' && chart.card.aggregate?.operation).toBe('sum');
    expect(result.spec.pages[1]!.filters?.[0]).toMatchObject({ id: 'when', kind: 'date_range' });
  });
});

describe('parseAppSpec — shape and pure checks', () => {
  it('rejects malformed ids, unknown keys and broken limits with field paths', () => {
    const spec = procurement();
    const bad = {
      ...spec,
      extra: true,
      pages: [{ ...spec.pages[0]!, id: 'Not OK' }, ...spec.pages.slice(1)],
    };
    const result = parseAppSpec(bad);
    expect(result.ok).toBe(false);
    expect(paths(result)).toEqual(expect.arrayContaining(['pages[0].id', '']));

    const tooMany = { ...spec, pages: Array.from({ length: 21 }, (_, i) => ({ ...spec.pages[2]!, id: `p${i}` })) };
    expect(paths(parseAppSpec(tooMany))).toContain('pages');
  });

  it('checks cross-references: duplicates, home, role pages, roles, $page refs, links, required inputs', () => {
    let spec = procurement();
    spec = { ...spec, home: 'nowhere', roles: [...spec.roles, { ...spec.roles[0]!, pages: ['ghost'] }] };
    spec = withCard(spec, 1, 0, (card) =>
      card.kind === 'kanban'
        ? {
            ...card,
            source: {
              tableId: T,
              query: {
                where: { combinator: 'and', clauses: [{ fieldId: F.due, operator: 'gte', value: '$page.nope' }] },
              },
            },
            actions: [
              { ...card.actions![0]!, roles: ['nobody'] },
              {
                ...card.actions![1]!,
                id: 'approve',
                do: { type: 'set_fields', values: [], requiredInputFieldIds: [F.reason] },
              },
            ],
          }
        : card,
    );
    spec = withCard(spec, 2, 2, (card) =>
      card.kind === 'buttons'
        ? {
            ...card,
            buttons: [
              { id: 'js', label: 'Run', type: 'open_url', url: 'javascript:alert(1)' },
              { id: 'go', label: 'Go', type: 'open_page', pageId: 'ghost' },
            ],
          }
        : card,
    );
    const result = parseAppSpec(spec);
    expect(result.ok).toBe(false);
    const messages = result.ok ? [] : result.errors.map((error) => `${error.path}: ${error.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        'roles[2].key: Role "applicant" is defined twice',
        'home: Home page "nowhere" does not exist',
        'roles[2].pages[0]: Page "ghost" does not exist',
        'pages[1].cards[0].actions[0].roles[0]: Unknown role "nobody"',
        'pages[1].cards[0].actions[1].id: Action "approve" is defined twice on this card',
        expect.stringMatching(/^pages\[1\]\.cards\[0\]\.actions\[1\]\.do\.requiredInputFieldIds\[0\]/),
        'pages[1].cards[0].source.query: $page.nope does not name a filter of this page',
        'pages[2].cards[2].buttons[0].url: Links must be http(s) URLs or in-app #/ links',
        'pages[2].cards[2].buttons[1].pageId: Page "ghost" does not exist',
      ]),
    );
  });
});

describe('validateAppSpec — against the Base', () => {
  it('requires tables of the Base and live fields of the right type', async () => {
    let spec = withCard(procurement(), 0, 0, (card) =>
      card.kind === 'records' ? { ...card, source: { tableId: OTHER }, fieldIds: [F.title] } : card,
    );
    spec = withCard(spec, 1, 0, (card) => (card.kind === 'kanban' ? { ...card, groupFieldId: F.amount } : card));
    spec = withCard(spec, 0, 1, (card) => (card.kind === 'form' ? { ...card, fieldIds: [F.doubled, 999] } : card));
    const result = await validateAppSpec(spec, schema());
    expect(result.ok).toBe(false);
    const errors = result.ok ? [] : result.errors;
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'pages[0].cards[0].source.tableId', cardId: 'list' }),
        expect.objectContaining({ path: 'pages[1].cards[0].groupFieldId', message: expect.stringContaining('kanban') }),
        expect.objectContaining({
          path: 'pages[0].cards[1].fieldIds[0]',
          message: expect.stringContaining('computed'),
        }),
        expect.objectContaining({ path: 'pages[0].cards[1].fieldIds[1]', message: expect.stringContaining('999') }),
      ]),
    );
    // The shape was fine, so the spec comes back (a draft can still be saved).
    expect(!result.ok && result.spec).toBeTruthy();
  });

  it('requires set_fields keys to be editable for every role the action applies to', async () => {
    const spec = procurement();
    // Approvers may no longer edit "Approved at".
    spec.roles[1]!.tables = [
      { tableId: T, access: 'edit', fields: [{ fieldId: F.approvedAt, access: 'read' }], fieldDefault: 'visible' },
    ];
    const result = await validateAppSpec(spec, schema());
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toContainEqual(
      expect.objectContaining({
        path: 'pages[1].cards[0].actions[0].do',
        actionId: 'approve',
        message: `Role "approver" cannot edit field ${F.approvedAt} on table ${T}`,
      }),
    );

    // Without `roles`, the action applies to every role that sees the page — a read-only role blocks it.
    const open = withCard(procurement(), 1, 0, (card) =>
      card.kind === 'kanban' ? { ...card, actions: [{ ...card.actions![1]!, roles: undefined }] } : card,
    );
    open.roles.push({ key: 'auditor', name: 'Auditor', pages: 'all', tables: [{ ...editRule(), access: 'read' }] });
    const blocked = await validateAppSpec(open, schema());
    expect(blocked.ok ? [] : blocked.errors.map((error) => error.message)).toContainEqual(
      expect.stringContaining('Role "auditor" cannot edit'),
    );
  });

  it('checks action values, tokens, button rules and queries with the db validators', async () => {
    const spec = withCard(procurement(), 1, 0, (card) =>
      card.kind === 'kanban'
        ? {
            ...card,
            actions: [
              {
                id: 'bad',
                label: 'Bad',
                roles: ['approver'],
                when: { combinator: 'and', clauses: [{ fieldId: 4242, operator: 'eq', value: 'x' }] },
                do: {
                  type: 'set_fields',
                  values: [
                    { fieldId: F.status, value: 'no-such-option' },
                    { fieldId: F.amount, value: '$me' },
                  ],
                },
              },
              { id: 'run', label: 'Run', roles: ['approver'], do: { type: 'run_automation', ruleId: 8 } },
            ],
          }
        : card,
    );
    const result = await validateAppSpec(spec, schema());
    const errors = result.ok ? [] : result.errors;
    expect(errors.map((error) => error.path)).toEqual(
      expect.arrayContaining([
        'pages[1].cards[0].actions[0].when',
        'pages[1].cards[0].actions[0].do.values[0]',
        'pages[1].cards[0].actions[0].do.values[1]',
        'pages[1].cards[0].actions[1].do.ruleId',
      ]),
    );
  });
});

describe('revalidateSpec — runtime degradation (D6)', () => {
  it('turns a deleted field into issues on exactly the cards and actions that use it', async () => {
    const spec = procurement();
    expect(await revalidateSpec(spec, schema())).toEqual([]);

    const issues = await revalidateSpec(spec, schema({ drop: [F.approvedAt, F.due], buttonRules: [] }));
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pageId: 'approve', cardId: 'board', actionId: 'approve' }),
        expect.objectContaining({ pageId: 'approve', cardId: 'board', actionId: 'notify' }),
        expect.objectContaining({ pageId: 'approve', filterId: 'when' }),
        expect.objectContaining({ pageId: 'stats', cardId: 'monthly' }),
      ]),
    );
    expect(issues.some((issue) => issue.pageId === 'mine')).toBe(false);
  });
});
