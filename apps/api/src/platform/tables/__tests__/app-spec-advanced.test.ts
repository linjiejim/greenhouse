/**
 * The app spec validator for Phase 2's card kinds (docs/specs/20261011-tables-apps-advanced.md
 * §1, §5): custom components (code size, bindings only over this Base, records
 * bindings with columns, aggregate bindings with an aggregate, actions and
 * create through a records binding, never `delete`) and external data cards
 * (tool / connector sources with a declarative map — accepted on external cards
 * only, never on a records-like card and never in a custom card's bindings).
 */

import { describe, expect, it } from 'vitest';
import type { AppCard, AppSpec } from '@greenhouse/types/apps';
import { APP_SANDBOX_LIMITS } from '@greenhouse/types/app-sandbox';
import { parseAppSpec, parseStoredAppSpec, revalidateSpec, validateAppSpec } from '../app-spec.js';
import { F, layout, OTHER, paths, procurement, schema, T, withCard } from './fixtures/app-spec-base.js';

type CustomCard = Extract<AppCard, { kind: 'custom' }>;
type ExternalCard = Extract<AppCard, { kind: 'external' }>;

function timeline(change: Partial<CustomCard> = {}): CustomCard {
  return {
    id: 'timeline',
    kind: 'custom',
    title: 'Timeline',
    layout,
    html: '<div id="gantt"></div><script>window.greenhouse.query("rows").then(() => {})</script>',
    bindings: [
      {
        id: 'rows',
        kind: 'records',
        source: {
          tableId: T,
          query: { where: { combinator: 'and', clauses: [{ fieldId: F.status, operator: 'eq', value: 'pending' }] } },
        },
        fieldIds: [F.title, F.due, F.status],
      },
      {
        id: 'by-status',
        kind: 'aggregate',
        source: { tableId: T },
        aggregate: { operation: 'sum', valueFieldId: F.amount, groupBy: { fieldId: F.status } },
      },
      { id: 'total', kind: 'aggregate', source: { tableId: T }, aggregate: { operation: 'count' } },
    ],
    actions: [
      {
        id: 'approve',
        label: 'Approve',
        bindingId: 'rows',
        roles: ['approver'],
        when: { combinator: 'and', clauses: [{ fieldId: F.status, operator: 'eq', value: 'pending' }] },
        do: { type: 'set_fields', values: [{ fieldId: F.status, value: 'approved' }] },
      },
      {
        id: 'notify',
        label: 'Notify',
        bindingId: 'rows',
        roles: ['approver'],
        do: { type: 'run_automation', ruleId: 7 },
      },
    ],
    create: { bindingId: 'rows', fieldIds: [F.title, F.amount], roles: ['approver'] },
    height: 480,
    ...change,
  };
}

function issues(change: Partial<ExternalCard['source']> = {}, card: Partial<ExternalCard> = {}): ExternalCard {
  return {
    id: 'issues',
    kind: 'external',
    title: 'Open issues',
    layout,
    source: {
      kind: 'connector',
      server: 'github',
      tool: 'list_issues',
      input: { state: 'open' },
      map: {
        kind: 'table',
        rows: '/items',
        columns: [
          { key: 'title', label: 'Title', path: '/title' },
          { key: 'opened', label: 'Opened', path: '/created_at', type: 'datetime' },
        ],
      },
      ...change,
    } as ExternalCard['source'],
    ...card,
  };
}

/** The procurement app with `cards` added to its statistics page (the approver sees every page). */
function withCards(...cards: AppCard[]): AppSpec {
  const spec = procurement();
  return {
    ...spec,
    pages: spec.pages.map((page, index) => (index === 2 ? { ...page, cards: [...page.cards, ...cards] } : page)),
  };
}

const CARD = 'pages[2].cards[3]';

describe('custom cards', () => {
  it('accept a component that reads records and an aggregate and runs declared actions', async () => {
    const result = await validateAppSpec(withCards(timeline()), schema());
    expect(result.ok, JSON.stringify(result)).toBe(true);
    // Stored as text and read back, the shape survives.
    const stored = parseStoredAppSpec(JSON.stringify(withCards(timeline())));
    expect(stored?.pages[2]!.cards[3]).toMatchObject({ kind: 'custom', bindings: [{ id: 'rows' }, {}, {}] });
  });

  it('refuse code over the size limit, counted in UTF-8 bytes', () => {
    const tooManyCharacters = parseAppSpec(withCards(timeline({ html: 'a'.repeat(APP_SANDBOX_LIMITS.htmlBytes + 1) })));
    expect(paths(tooManyCharacters)).toContain(`${CARD}.html`);
    // 70 000 characters, 210 000 bytes: fine for the shape, over the limit in bytes.
    const tooManyBytes = parseAppSpec(withCards(timeline({ html: '审'.repeat(70_000) })));
    expect(tooManyBytes.ok).toBe(false);
    expect(!tooManyBytes.ok && tooManyBytes.errors).toEqual([
      expect.objectContaining({ path: `${CARD}.html`, cardId: 'timeline', message: expect.stringContaining('KB') }),
    ]);
  });

  it('never declare a delete', () => {
    const result = parseAppSpec(
      withCards(timeline({ actions: [{ id: 'drop', label: 'Drop', bindingId: 'rows', do: { type: 'delete' } }] })),
    );
    expect(!result.ok && result.errors).toEqual([
      expect.objectContaining({
        path: `${CARD}.actions[0].do`,
        actionId: 'drop',
        message: 'A custom card cannot delete records',
      }),
    ]);
  });

  it('write only through a records binding of the card, and keep binding shapes straight', () => {
    const result = parseAppSpec(
      withCards(
        timeline({
          bindings: [
            { id: 'rows', kind: 'records', source: { tableId: T } },
            { id: 'sum', kind: 'aggregate', source: { tableId: T }, fieldIds: [F.amount] },
            { id: 'rows', kind: 'records', source: { tableId: T }, fieldIds: [F.title] },
          ],
          actions: [
            {
              id: 'a',
              label: 'A',
              bindingId: 'sum',
              do: { type: 'set_fields', values: [{ fieldId: F.status, value: 'approved' }] },
            },
            { id: 'b', label: 'B', bindingId: 'nope', do: { type: 'run_automation', ruleId: 7 } },
          ],
          create: { bindingId: 'sum', fieldIds: [F.title] },
        }),
      ),
    );
    expect(!result.ok && result.errors.map((error) => [error.path, error.message])).toEqual(
      expect.arrayContaining([
        [`${CARD}.bindings[0].fieldIds`, 'A records binding needs the fields it reads'],
        [`${CARD}.bindings[1].aggregate`, 'An aggregate binding needs an aggregate'],
        [`${CARD}.bindings[1].fieldIds`, 'An aggregate binding has no columns'],
        [`${CARD}.bindings[2].id`, 'Binding "rows" is defined twice on this card'],
        [`${CARD}.actions[0].bindingId`, 'Binding "sum" is an aggregate; actions need a records binding'],
        [`${CARD}.actions[1].bindingId`, 'Binding "nope" does not exist on this card'],
        [`${CARD}.create.bindingId`, 'Binding "sum" is an aggregate; actions need a records binding'],
      ]),
    );
  });

  it('read only tables of this Base, through fields that exist and editable keys for every role', async () => {
    const card = timeline({
      bindings: [
        { id: 'rows', kind: 'records', source: { tableId: T }, fieldIds: [F.title, 999] },
        { id: 'elsewhere', kind: 'records', source: { tableId: OTHER }, fieldIds: [1] },
      ],
      actions: [
        // No `roles`: every role that sees the page — the applicant cannot see it, the approver can edit.
        {
          id: 'stamp',
          label: 'Stamp',
          bindingId: 'rows',
          do: { type: 'set_fields', values: [{ fieldId: F.doubled, value: 2 }] },
        },
      ],
      create: undefined,
    });
    const result = await validateAppSpec(withCards(card), schema());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: `${CARD}.bindings[0].source.query`, bindingId: 'rows' }),
        expect.objectContaining({ path: `${CARD}.bindings[1].source.tableId`, bindingId: 'elsewhere' }),
        expect.objectContaining({
          path: `${CARD}.actions[0].do.values[0].fieldId`,
          actionId: 'stamp',
          message: expect.stringContaining('computed'),
        }),
      ]),
    );
  });

  it('never take a tool or connector source in a binding', () => {
    const spec = withCards(timeline()) as unknown as { pages: Array<{ cards: Array<Record<string, unknown>> }> };
    const card = spec.pages[2]!.cards[3]!;
    card.bindings = [
      {
        id: 'rows',
        kind: 'records',
        source: { kind: 'tool', toolId: 'project_query', input: {}, map: { kind: 'kpi', value: '' } },
        fieldIds: [1],
      },
    ];
    const result = parseAppSpec(spec);
    expect(!result.ok && result.errors).toEqual([
      expect.objectContaining({
        path: `${CARD}.bindings[0].source`,
        message: 'A custom card reads this Base only — no tool or connector sources in its bindings',
      }),
    ]);
  });

  it('turn unavailable at runtime when the schema moves under a binding (D6)', async () => {
    const result = await revalidateSpec(withCards(timeline()), schema({ drop: [F.due] }));
    // The procurement cards that use the field turn unavailable too; the timeline is one of them.
    expect(result.filter((issue) => issue.cardId === 'timeline')).toEqual([
      expect.objectContaining({ pageId: 'stats', cardId: 'timeline', message: expect.stringContaining(String(F.due)) }),
    ]);
  });
});

describe('external data cards', () => {
  it('accept a connector table, a tool KPI and a chart with its options', async () => {
    const kpi: ExternalCard = {
      ...issues(),
      id: 'open-tasks',
      source: {
        kind: 'tool',
        toolId: 'project_query',
        input: { action: 'list' },
        map: { kind: 'kpi', value: '/total' },
      },
    };
    const chart = issues(
      { map: { kind: 'chart', rows: '', group: '/state', value: '/count', series: '/repo' } },
      { id: 'by-state', chart: { type: 'bar', stacked: true } },
    );
    const result = await validateAppSpec(withCards(issues(), kpi, chart), schema());
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('are the only cards a tool or connector source may sit on', () => {
    const external = { kind: 'tool', toolId: 'project_query', input: {}, map: { kind: 'kpi', value: '' } };
    const records = withCard(procurement(), 0, 0, (card) => ({ ...card, source: external }) as unknown as AppCard);
    const kpi = withCard(procurement(), 2, 0, (card) => ({ ...card, source: external }) as unknown as AppCard);
    for (const [spec, path] of [
      [records, 'pages[0].cards[0].source'],
      [kpi, 'pages[2].cards[0].source'],
    ] as const) {
      const result = parseAppSpec(spec);
      expect(!result.ok && result.errors).toEqual([
        expect.objectContaining({ path, message: 'Tool and connector sources are only for external cards' }),
      ]);
    }
  });

  it('refuse bad pointers, duplicate columns, chart options off a chart, unknown slugs and oversized input', () => {
    const result = parseAppSpec(
      withCards(
        issues(
          {
            map: {
              kind: 'table',
              rows: 'items',
              columns: [
                { key: 'title', label: 'Title', path: '/title' },
                { key: 'title', label: 'Again', path: '/a~2' },
              ],
            },
          },
          { chart: { type: 'pie' } },
        ),
        issues({ server: 'Not A Slug', input: { blob: 'x'.repeat(9_000) } }, { id: 'second' }),
        issues({ input: { blob: 'x'.repeat(9_000) } }, { id: 'third' }),
      ),
    );
    expect(paths(result)).toEqual(
      expect.arrayContaining([
        `${CARD}.source.map.rows`,
        `${CARD}.source.map.columns[1].path`,
        'pages[2].cards[4].source.server',
      ]),
    );
    const pure = parseAppSpec(
      withCards(
        issues(
          {
            map: {
              kind: 'table',
              rows: '/items',
              columns: [
                { key: 'title', label: 'Title', path: '/title' },
                { key: 'title', label: 'Again', path: '/name' },
              ],
            },
          },
          { chart: { type: 'pie' } },
        ),
        issues({ input: { blob: 'x'.repeat(9_000) } }, { id: 'third' }),
      ),
    );
    expect(paths(pure)).toEqual([
      `${CARD}.source.map.columns[1].key`,
      `${CARD}.chart`,
      'pages[2].cards[4].source.input',
    ]);
  });
});
