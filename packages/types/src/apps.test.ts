import { describe, expect, it } from 'vitest';
import {
  actionAllowedForRole,
  aggregateBindingCard,
  APP_CARD_KINDS,
  appSpecDependencies,
  externalDisplay,
  isJsonPointer,
  MOBILE_APP_CARDS,
  pagesForRole,
  readJsonPointer,
  type AppCard,
  type AppSpec,
} from './apps.js';

const spec: AppSpec = {
  version: 1,
  roles: [
    {
      key: 'applicant',
      name: 'Applicant',
      pages: ['mine'],
      tables: [
        {
          tableId: 1,
          access: 'edit',
          rows: { type: 'related', creator: true, fieldIds: [] },
          fields: [{ fieldId: 13, access: 'hidden' }],
          fieldDefault: 'visible',
        },
      ],
    },
    { key: 'approver', name: 'Approver', pages: 'all', tables: [] },
  ],
  pages: [
    {
      id: 'mine',
      title: 'My requests',
      cards: [
        {
          id: 'list',
          kind: 'records',
          layout: { x: 0, y: 0, w: 12, h: 6 },
          source: {
            tableId: 1,
            query: {
              where: { combinator: 'and', clauses: [{ systemField: 'created_by', operator: 'eq', value: '$me' }] },
            },
          },
          fieldIds: [10, 11],
        },
      ],
    },
    {
      id: 'review',
      title: 'Review',
      filters: [{ id: 'when', label: 'When', kind: 'date_range', targets: [{ tableId: 1, fieldId: 12 }] }],
      cards: [
        {
          id: 'board',
          kind: 'kanban',
          layout: { x: 0, y: 0, w: 12, h: 8 },
          source: { tableId: 1 },
          groupFieldId: 14,
          fieldIds: [10],
          actions: [
            {
              id: 'approve',
              label: 'Approve',
              roles: ['approver'],
              when: { combinator: 'and', clauses: [{ fieldId: 14, operator: 'eq', value: 'pending' }] },
              do: { type: 'set_fields', values: [{ fieldId: 14, value: 'approved' }], inputFieldIds: [15] },
            },
            { id: 'notify', label: 'Notify', do: { type: 'run_automation', ruleId: 3 } },
          ],
        },
        {
          id: 'total',
          kind: 'kpi',
          layout: { x: 0, y: 8, w: 4, h: 3 },
          card: { kind: 'kpi', source: { tableId: 2 }, aggregate: { operation: 'sum', valueFieldId: 20 } },
        },
      ],
    },
  ],
};

describe('apps spec helpers', () => {
  it('limits pages by role', () => {
    expect(pagesForRole(spec, spec.roles[0]!).map((page) => page.id)).toEqual(['mine']);
    expect(pagesForRole(spec, spec.roles[1]!).map((page) => page.id)).toEqual(['mine', 'review']);
  });

  it('allows an action only to listed roles that can see the page', () => {
    const approve = spec.pages[1]!.cards[0]!;
    if (approve.kind !== 'kanban') throw new Error('fixture');
    const action = approve.actions![0]!;
    expect(actionAllowedForRole(spec, 'review', action, 'approver')).toBe(true);
    expect(actionAllowedForRole(spec, 'review', action, 'applicant')).toBe(false);
    expect(actionAllowedForRole(spec, 'review', approve.actions![1]!, 'applicant')).toBe(false);
    expect(actionAllowedForRole(spec, 'review', approve.actions![1]!, 'approver')).toBe(true);
  });

  it('collects every table, field, rule and role the spec depends on', () => {
    expect(appSpecDependencies(spec)).toEqual({
      tableIds: [1, 2],
      fieldIds: [10, 11, 12, 13, 14, 15, 20],
      ruleIds: [3],
      roleKeys: ['applicant', 'approver'],
    });
  });
});

describe('Phase 2 card kinds', () => {
  const custom: AppCard = {
    id: 'timeline',
    kind: 'custom',
    layout: { x: 0, y: 0, w: 12, h: 6 },
    html: '<div id="t"></div>',
    bindings: [
      {
        id: 'tasks',
        kind: 'records',
        source: {
          tableId: 4,
          query: { where: { combinator: 'and', clauses: [{ fieldId: 41, operator: 'eq', value: 'open' }] } },
        },
        fieldIds: [40, 42],
      },
      {
        id: 'by-owner',
        kind: 'aggregate',
        source: { tableId: 5 },
        aggregate: { operation: 'sum', valueFieldId: 50, groupBy: { fieldId: 51 } },
      },
    ],
    actions: [
      {
        id: 'done',
        label: 'Done',
        bindingId: 'tasks',
        when: { combinator: 'and', clauses: [{ fieldId: 43, operator: 'eq', value: 'x' }] },
        do: { type: 'set_fields', values: [{ fieldId: 41, value: 'done' }], inputFieldIds: [44] },
      },
      { id: 'notify', label: 'Notify', bindingId: 'tasks', do: { type: 'run_automation', ruleId: 9 } },
    ],
    create: { bindingId: 'tasks', fieldIds: [40], defaults: [{ fieldId: 45, value: '$me' }] },
  };
  const external: AppCard = {
    id: 'issues',
    kind: 'external',
    layout: { x: 0, y: 6, w: 6, h: 4 },
    source: {
      kind: 'connector',
      server: 'github',
      tool: 'list_issues',
      input: { state: 'open' },
      map: { kind: 'table', rows: '/items', columns: [{ key: 'title', label: 'Title', path: '/title' }] },
    },
  };

  it('are catalogued, but the phone does not claim to draw them yet', () => {
    expect(APP_CARD_KINDS).toEqual(expect.arrayContaining(['custom', 'external']));
    expect(MOBILE_APP_CARDS).not.toContain('custom');
    expect(MOBILE_APP_CARDS).not.toContain('external');
    expect(MOBILE_APP_CARDS.every((kind) => APP_CARD_KINDS.includes(kind as never))).toBe(true);
  });

  it('count a custom card’s bindings, actions and create as dependencies; external cards have none', () => {
    const deps = appSpecDependencies({
      version: 1,
      roles: [{ key: 'member', name: 'Member', pages: 'all', tables: [] }],
      pages: [{ id: 'home', title: 'Home', cards: [custom, external] }],
    });
    expect(deps).toEqual({
      tableIds: [4, 5],
      fieldIds: [40, 41, 42, 43, 44, 45, 50, 51],
      ruleIds: [9],
      roleKeys: ['member'],
    });
  });

  it('evaluate an aggregate binding as a KPI without a dimension, else as pivot rows', () => {
    if (custom.kind !== 'custom') throw new Error('fixture');
    expect(aggregateBindingCard(custom.bindings[1]!)).toEqual({
      kind: 'pivot',
      source: { tableId: 5 },
      aggregate: { operation: 'sum', valueFieldId: 50, groupBy: { fieldId: 51 } },
    });
    expect(aggregateBindingCard({ id: 'n', kind: 'aggregate', source: { tableId: 5 } })).toEqual({
      kind: 'kpi',
      source: { tableId: 5 },
      aggregate: { operation: 'count' },
    });
  });

  it('show external data as their map says', () => {
    if (external.kind !== 'external') throw new Error('fixture');
    expect(externalDisplay(external.source)).toBe('table');
  });
});

describe('JSON pointers (external source maps)', () => {
  const doc = { items: [{ title: 'A', 'a/b': 1, 'm~n': 2 }, { title: 'B' }], count: '7' };

  it('recognises RFC 6901 pointers only', () => {
    for (const pointer of ['', '/items', '/items/0/title', '/items/0/a~1b', '/items/0/m~0n']) {
      expect(isJsonPointer(pointer), pointer).toBe(true);
    }
    for (const pointer of ['items', '/a~2b', '/a~', 7, null, `/${'x'.repeat(300)}`]) {
      expect(isJsonPointer(pointer), String(pointer)).toBe(false);
    }
  });

  it('reads values, escapes included, and names nothing it cannot reach', () => {
    expect(readJsonPointer(doc, '')).toBe(doc);
    expect(readJsonPointer(doc, '/items/1/title')).toBe('B');
    expect(readJsonPointer(doc, '/items/0/a~1b')).toBe(1);
    expect(readJsonPointer(doc, '/items/0/m~0n')).toBe(2);
    expect(readJsonPointer(doc, '/count')).toBe('7');
    expect(readJsonPointer(doc, '/items/2/title')).toBeUndefined();
    expect(readJsonPointer(doc, '/items/-')).toBeUndefined();
    expect(readJsonPointer(doc, '/items/01')).toBeUndefined();
    expect(readJsonPointer(doc, '/items/0/title/x')).toBeUndefined();
    expect(readJsonPointer(doc, '/constructor')).toBeUndefined();
  });
});
