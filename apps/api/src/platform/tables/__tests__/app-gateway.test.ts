/**
 * The pure parts of the app gateway (slice G): how a card query becomes part
 * of a scope (`$page` values compared by the clause's operator, row scopes),
 * where a spec uses a structure
 * object (D6 — and that it covers `appSpecDependencies`), and what a role's
 * copy of the spec withholds.
 */

import { describe, expect, it } from 'vitest';
import { appSpecDependencies, type AppSpec } from '@greenhouse/types/apps';
import type { TableFilterGroup } from '@greenhouse/types/tables';
import { specPlaces, specReferences } from '../app-references.js';
import { cardDisplayFieldIds, pageRefGroups, queryFieldIds, queryRowScopes, resolvePageRefs } from '../app-scope.js';
import { viewerSpec } from '../app-viewer.js';

const layout = { x: 0, y: 0, w: 6, h: 4 };
const T = 10;
const V = 20;

function spec(): AppSpec {
  return {
    version: 1,
    pages: [
      {
        id: 'p1',
        title: 'Requests',
        filters: [
          {
            id: 'dept',
            label: 'Department',
            kind: 'select',
            targets: [{ tableId: T, fieldId: 105 }],
            defaultValue: { kind: 'select', values: ['ops'] },
          },
        ],
        cards: [
          {
            id: 'list',
            title: 'All',
            kind: 'records',
            layout,
            source: {
              tableId: T,
              query: {
                where: {
                  combinator: 'and',
                  clauses: [
                    { fieldId: 102, operator: 'eq', value: 'pending' },
                    { fieldId: 105, operator: 'in', value: '$page.dept' },
                  ],
                },
                sort: [{ fieldId: 103, direction: 'desc' }],
              },
            },
            fieldIds: [101, 104],
            detail: { fieldIds: [101, 104, 106], editableFieldIds: [106], comments: true },
            actions: [
              {
                id: 'approve',
                label: 'Approve',
                when: { combinator: 'and', clauses: [{ fieldId: 107, operator: 'is_empty' }] },
                do: { type: 'set_fields', values: [{ fieldId: 102, value: 'approved' }], inputFieldIds: [108] },
              },
              { id: 'escalate', label: 'Escalate', do: { type: 'run_automation', ruleId: 77 } },
            ],
            create: { fieldIds: [101], defaults: [{ fieldId: 107, value: 'x' }] },
          },
          {
            id: 'board',
            kind: 'kanban',
            layout,
            source: { tableId: T },
            groupFieldId: 102,
            coverFieldId: 109,
            fieldIds: [101],
            move: { when: { combinator: 'and', clauses: [{ fieldId: 110, operator: 'eq', value: 'x' }] } },
          },
          {
            id: 'total',
            kind: 'kpi',
            layout,
            card: {
              kind: 'kpi',
              source: {
                tableId: T,
                query: { where: { combinator: 'and', clauses: [{ fieldId: 107, operator: 'gt', value: 1 }] } },
              },
              aggregate: { operation: 'sum', valueFieldId: 103 },
            },
          },
          {
            id: 'form',
            kind: 'form',
            layout,
            tableId: T,
            fieldIds: [101, 104, 107],
            defaults: [
              { fieldId: 107, value: 'hidden default' },
              { fieldId: 102, value: 'pending' },
            ],
          },
          {
            id: 'buttons',
            kind: 'buttons',
            layout,
            buttons: [{ id: 'add', label: 'Add', type: 'create_record', tableId: V, fieldIds: [201, 202] }],
          },
        ],
      },
    ],
    roles: [
      {
        key: 'r',
        name: 'Reader',
        pages: 'all',
        tables: [
          {
            tableId: T,
            access: 'edit',
            rows: {
              type: 'where',
              where: { combinator: 'and', clauses: [{ fieldId: 111, operator: 'eq', value: 'y' }] },
            },
            fields: [{ fieldId: 107, access: 'hidden' }],
            fieldDefault: 'visible',
          },
        ],
      },
    ],
  };
}

describe('card queries as scope', () => {
  it('turns predicates into read rows, a $page clause into no constraint (AND) or none at all (OR)', () => {
    const query = {
      where: {
        combinator: 'and' as const,
        clauses: [
          { fieldId: 1, operator: 'eq' as const, value: 'x' },
          { fieldId: 2, operator: 'in' as const, value: '$page.f' },
        ],
      },
      filters: [
        {
          combinator: 'or' as const,
          clauses: [
            { fieldId: 3, operator: 'eq' as const, value: 'a' },
            { fieldId: 4, operator: 'eq' as const, value: '$page.g' },
          ],
        },
        { combinator: 'and' as const, clauses: [] },
      ],
    };
    expect(queryRowScopes(query)).toEqual([
      { type: 'where', where: { combinator: 'and', clauses: [{ fieldId: 1, operator: 'eq', value: 'x' }] } },
    ]);
    expect(queryFieldIds(query).sort()).toEqual([1, 3]);
  });

  it('resolves $page clauses into AND-ed groups, inlines single clauses into OR groups, drops what it cannot hold', () => {
    const query = {
      where: {
        combinator: 'and' as const,
        clauses: [
          { fieldId: 1, operator: 'eq' as const, value: 'x' },
          { fieldId: 2, operator: 'in' as const, value: '$page.f' },
        ],
      },
      filters: [
        {
          combinator: 'or' as const,
          clauses: [
            { fieldId: 3, operator: 'eq' as const, value: 'a' },
            { fieldId: 4, operator: 'eq' as const, value: '$page.g' },
          ],
        },
      ],
      sort: [{ fieldId: 1, direction: 'asc' as const }],
    };
    const single: TableFilterGroup = { combinator: 'or', clauses: [{ fieldId: 9, operator: 'in', value: ['v'] }] };
    const pair: TableFilterGroup = {
      combinator: 'and',
      clauses: [
        { fieldId: 9, operator: 'gte', value: '2026-01-01' },
        { fieldId: 9, operator: 'lte', value: '2026-01-31' },
      ],
    };
    expect(resolvePageRefs(query, () => [single])).toEqual({
      where: { combinator: 'and', clauses: [{ fieldId: 1, operator: 'eq', value: 'x' }] },
      filters: [
        {
          combinator: 'or',
          clauses: [
            { fieldId: 3, operator: 'eq', value: 'a' },
            { fieldId: 9, operator: 'in', value: ['v'] },
          ],
        },
        single,
      ],
      sort: [{ fieldId: 1, direction: 'asc' as const }],
    });
    // No value: the AND clause is gone, the OR group is no constraint.
    expect(resolvePageRefs(query, () => [])).toEqual({
      where: { combinator: 'and', clauses: [{ fieldId: 1, operator: 'eq', value: 'x' }] },
      sort: [{ fieldId: 1, direction: 'asc' as const }],
    });
    // A two-sided range cannot sit inside an OR group: that group is no constraint.
    expect(resolvePageRefs(query, ({ filterId }) => (filterId === 'g' ? [pair] : [])).filters).toBeUndefined();
  });

  it('compares a $page value the way the clause’s operator says', () => {
    const select: TableFilterGroup = { combinator: 'or', clauses: [{ fieldId: 9, operator: 'in', value: ['a', 'b'] }] };
    const multi: TableFilterGroup = {
      combinator: 'or',
      clauses: [
        { fieldId: 8, operator: 'contains', value: 'a' },
        { fieldId: 8, operator: 'contains', value: 'b' },
      ],
    };
    const range: TableFilterGroup = {
      combinator: 'and',
      clauses: [
        { fieldId: 7, operator: 'gte', value: '2026-01-01' },
        { fieldId: 7, operator: 'lte', value: '2026-01-31' },
      ],
    };
    const text: TableFilterGroup = { combinator: 'or', clauses: [{ fieldId: 6, operator: 'contains', value: 'desk' }] };

    // Match: the filter's own predicate.
    for (const operator of ['eq', 'in', 'contains'] as const) {
      expect(pageRefGroups(operator, 'select', [select])).toEqual([select]);
    }
    expect(pageRefGroups('eq', 'date_range', [range])).toEqual([range]);
    // Exclude: none of the picked options, outside the range.
    expect(pageRefGroups('neq', 'select', [select])).toEqual([
      {
        combinator: 'and',
        clauses: [
          { fieldId: 9, operator: 'neq', value: 'a' },
          { fieldId: 9, operator: 'neq', value: 'b' },
        ],
      },
    ]);
    expect(pageRefGroups('not_contains', 'select', [multi])).toEqual([
      {
        combinator: 'and',
        clauses: [
          { fieldId: 8, operator: 'not_contains', value: 'a' },
          { fieldId: 8, operator: 'not_contains', value: 'b' },
        ],
      },
    ]);
    expect(pageRefGroups('neq', 'date_range', [range])).toEqual([
      {
        combinator: 'or',
        clauses: [
          { fieldId: 7, operator: 'lt', value: '2026-01-01' },
          { fieldId: 7, operator: 'gt', value: '2026-01-31' },
        ],
      },
    ]);
    // One side of a range.
    const side = (operator: 'gte' | 'lte' | 'gt' | 'lt') => pageRefGroups(operator, 'date_range', [range]);
    expect(side('gte')).toEqual([{ combinator: 'and', clauses: [range.clauses[0]] }]);
    expect(side('lte')).toEqual([{ combinator: 'and', clauses: [range.clauses[1]] }]);
    expect(side('gt')).toEqual([{ combinator: 'and', clauses: [{ fieldId: 7, operator: 'gt', value: '2026-01-31' }] }]);
    expect(side('lt')).toEqual([{ combinator: 'and', clauses: [{ fieldId: 7, operator: 'lt', value: '2026-01-01' }] }]);
    // An open-ended range has no end to compare with: no constraint.
    const from: TableFilterGroup = { combinator: 'and', clauses: [range.clauses[0]!] };
    expect(pageRefGroups('gt', 'date_range', [from])).toEqual([]);
    // Search: the typed text under the clause's own operator.
    expect(pageRefGroups('eq', 'search', [text])).toEqual([
      { combinator: 'or', clauses: [{ fieldId: 6, operator: 'eq', value: 'desk' }] },
    ]);
    expect(pageRefGroups('not_contains', 'search', [text])).toEqual([
      { combinator: 'or', clauses: [{ fieldId: 6, operator: 'not_contains', value: 'desk' }] },
    ]);
    // A single negated option still inlines into an OR group; a negated pair cannot, so that group is no constraint.
    const one = pageRefGroups('neq', 'select', [{ ...select, clauses: [{ ...select.clauses[0]!, value: ['a'] }] }]);
    expect(one).toEqual([{ combinator: 'and', clauses: [{ fieldId: 9, operator: 'neq', value: 'a' }] }]);
  });

  it('shows the lane, date and cover fields of a card with its columns', () => {
    const board = spec().pages[0]!.cards[1]!;
    if (board.kind !== 'kanban') throw new Error('board');
    expect(cardDisplayFieldIds(board).sort()).toEqual([101, 102, 109]);
  });
});

describe('where apps use structure (D6)', () => {
  it('names the places a field, option, rule or table is used', () => {
    const s = spec();
    expect(specReferences(s, { fieldIds: [105] }, 'v2')).toEqual([
      'v2 › “Requests” › filter “Department”',
      'v2 › “Requests” › “All”',
    ]);
    expect(specReferences(s, { ruleIds: [77] }, 'draft')).toEqual(['draft › “Requests” › “All” › “Escalate”']);
    expect(specReferences(s, { options: { fieldId: 102, optionIds: ['approved'] } }, 'v1')).toEqual([
      'v1 › “Requests” › “All” › “Approve”',
    ]);
    expect(specReferences(s, { options: { fieldId: 105, optionIds: ['ops'] } }, 'v1')).toEqual([
      'v1 › “Requests” › filter “Department”',
    ]);
    expect(specReferences(s, { fieldIds: [111] }, 'v1')).toEqual(['v1 › role “Reader”']);
    expect(specReferences(s, { tableIds: [V] }, 'v1')).toEqual(['v1 › “Requests” › “buttons” › “Add”']);
    expect(specReferences(s, { fieldIds: [999] }, 'v1')).toEqual([]);
  });

  it('covers everything appSpecDependencies lists', () => {
    const s = spec();
    const deps = appSpecDependencies(s);
    const places = specPlaces(s, 'v1');
    const held = (pick: (holds: (typeof places)[number]['holds']) => Set<number>) =>
      new Set(places.flatMap((place) => [...pick(place.holds)]));
    const fields = held((holds) => holds.fields);
    const tables = held((holds) => holds.tables);
    const rules = held((holds) => holds.rules);
    expect(deps.fieldIds.filter((id) => !fields.has(id))).toEqual([]);
    expect(deps.tableIds.filter((id) => !tables.has(id))).toEqual([]);
    expect(deps.ruleIds.filter((id) => !rules.has(id))).toEqual([]);
  });
});

describe('a role’s copy of the spec', () => {
  it('withholds rules, unreadable fields, predicates and defaults that name them', () => {
    const readable = new Set([101, 102, 103, 104, 105, 106, 108, 110]);
    const editable = new Set([101, 102, 104, 106, 108]);
    const trimmed = viewerSpec(
      spec(),
      (tableId) => (tableId === T ? readable : undefined),
      (tableId) => (tableId === T ? editable : undefined),
    );
    expect(trimmed.roles[0]!.tables).toEqual([]);
    const [list, board, total, form, buttons] = trimmed.pages[0]!.cards;
    if (list?.kind !== 'records' || board?.kind !== 'kanban' || total?.kind !== 'kpi' || form?.kind !== 'form') {
      throw new Error('cards');
    }
    // The query only names readable fields ($page clause included): kept.
    expect(list.source.query).toBeDefined();
    expect(list.fieldIds).toEqual([101, 104]);
    expect(list.detail?.editableFieldIds).toEqual([106]);
    // `when` names a hidden field: dropped from the copy (the server still checks it).
    expect(list.actions?.[0]?.when).toBeUndefined();
    expect(list.create?.defaults).toBeUndefined();
    // The cover is not readable.
    expect(board.coverFieldId).toBeUndefined();
    expect(board.move?.when).toEqual({ combinator: 'and', clauses: [{ fieldId: 110, operator: 'eq', value: 'x' }] });
    // A kpi whose query needs a hidden field is reduced to its kind.
    expect(total.card).toEqual({ kind: 'kpi' });
    expect(form.fieldIds).toEqual([101, 104]);
    expect(form.defaults).toEqual([{ fieldId: 102, value: 'pending' }]);
    // A button on a table the role cannot write keeps no fields.
    expect(
      buttons?.kind === 'buttons' && buttons.buttons[0]?.type === 'create_record' && buttons.buttons[0].fieldIds,
    ).toEqual([]);
    expect(trimmed.pages[0]!.filters?.map((control) => control.id)).toEqual(['dept']);
    expect(queryFieldIds(list.source.query).every((id) => readable.has(id))).toBe(true);
  });
});
