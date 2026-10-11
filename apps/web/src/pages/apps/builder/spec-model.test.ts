/**
 * The builder's spec edits: starting cards for every kind (bound to a table
 * that can host them), what blocks a kind, ids, page / card / role edits that
 * keep the spec storable, and the references they clean up — never widening
 * who may use something.
 */

import { describe, expect, it } from 'vitest';
import { APP_CARD_KINDS, APP_ID_PATTERN, type AppCard, type AppSpec } from '@greenhouse/types/apps';
import {
  actionLabelsById,
  addCard,
  addPage,
  addRole,
  appliesTo,
  catalogBlocker,
  defaultCard,
  deletePage,
  deleteRole,
  eligibleTables,
  movePage,
  newCardId,
  nextCardLayout,
  pageDeletionBlockers,
  pageRef,
  removeCard,
  removePageFilter,
  retargetCard,
  roleListMentions,
  setCardLayouts,
  setHome,
  slugId,
  withList,
  type EmbeddedCard,
} from './spec-model';
import { FIELDS, NOTES, REQUESTS, schemaFixture, specFixture } from './test-fixtures';

const context = (kind: AppCard['kind'], tableId?: number) => ({
  schema: schemaFixture(),
  id: `${kind}-1`,
  layout: nextCardLayout([], kind),
  tableId,
  pageId: 'apply',
  buttonLabel: 'Open',
});

describe('slugId', () => {
  it('slugs a name, falls back for names without ASCII letters, and avoids taken and reserved ids', () => {
    expect(slugId('My Requests!', [], 'page')).toBe('my-requests');
    expect(slugId('采购申请', [], 'page')).toBe('page');
    expect(slugId('Home', ['home', 'home-2'], 'page')).toBe('home-3');
    expect(slugId('Edit', [], 'page', ['edit'])).toBe('edit-2');
    for (const id of ['my-requests', 'page', 'home-3', 'edit-2']) expect(APP_ID_PATTERN.test(id)).toBe(true);
  });
});

describe('starting cards', () => {
  it('gives every card kind a card bound to a table that can host it', () => {
    for (const kind of APP_CARD_KINDS) {
      const card = defaultCard(kind, context(kind));
      expect(card, kind).not.toBeNull();
      expect(card!.kind).toBe(kind);
      expect(APP_ID_PATTERN.test(card!.id)).toBe(true);
    }
    const kanban = defaultCard('kanban', context('kanban')) as Extract<AppCard, { kind: 'kanban' }>;
    expect(kanban.groupFieldId).toBe(FIELDS.status.id);
    expect(kanban.fieldIds).not.toContain(FIELDS.status.id);
    const calendar = defaultCard('calendar', context('calendar')) as Extract<AppCard, { kind: 'calendar' }>;
    expect(calendar.startFieldId).toBe(FIELDS.approvedAt.id);
    const gallery = defaultCard('gallery', context('gallery')) as Extract<AppCard, { kind: 'gallery' }>;
    expect(gallery.coverFieldId).toBe(FIELDS.quote.id);
    const form = defaultCard('form', context('form')) as Extract<AppCard, { kind: 'form' }>;
    // A form writes stored fields only (never the formula), primary first.
    expect(form.fieldIds[0]).toBe(FIELDS.item.id);
    expect(form.fieldIds).not.toContain(FIELDS.total.id);
    const chart = defaultCard('chart', context('chart')) as EmbeddedCard;
    expect(chart.card).toMatchObject({ kind: 'chart', aggregate: { operation: 'count', groupBy: { fieldId: 3 } } });
    const records = defaultCard('records', context('records')) as Extract<AppCard, { kind: 'records' }>;
    expect(records.title).toBe('Requests');
    // Attachments are not columns by default.
    expect(records.fieldIds).not.toContain(FIELDS.quote.id);
    const buttons = defaultCard('buttons', context('buttons')) as Extract<AppCard, { kind: 'buttons' }>;
    expect(buttons.buttons).toEqual([{ id: 'button-1', label: 'Open', type: 'open_page', pageId: 'apply' }]);
  });

  it('starts on the preferred table only when it can host the kind', () => {
    expect((defaultCard('records', context('records', NOTES)) as { source: { tableId: number } }).source.tableId).toBe(
      NOTES,
    );
    // Notes has no choice / person field: the board goes to Requests.
    expect((defaultCard('kanban', context('kanban', NOTES)) as { source: { tableId: number } }).source.tableId).toBe(
      REQUESTS,
    );
    expect(eligibleTables('kanban', schemaFixture()).map((table) => table.id)).toEqual([REQUESTS]);
  });

  it('says why a kind cannot be added', () => {
    const empty = schemaFixture({ tables: [], fieldsByTable: new Map() });
    expect(catalogBlocker('records', empty)).toBe('noTables');
    expect(catalogBlocker('text', empty)).toBeNull();
    expect(catalogBlocker('buttons', empty)).toBeNull();
    const notesOnly = schemaFixture({
      tables: schemaFixture().tables.filter((table) => table.id === NOTES),
    });
    expect(catalogBlocker('kanban', notesOnly)).toBe('noLaneField');
    expect(catalogBlocker('calendar', notesOnly)).toBe('noDateField');
    expect(catalogBlocker('records', notesOnly)).toBeNull();
  });

  it('places a new card below the others', () => {
    expect(nextCardLayout(specFixture().pages[0]!.cards, 'kpi')).toEqual({ x: 0, y: 6, w: 3, h: 3 });
    expect(newCardId(specFixture().pages[0]!, 'records')).toBe('records-2');
    expect(newCardId(specFixture().pages[0]!, 'kpi')).toBe('kpi-1');
  });

  it('moves a card to another table: field settings start over, a written title stays', () => {
    const schema = schemaFixture();
    const card = defaultCard('records', context('records')) as Extract<AppCard, { kind: 'records' }>;
    const moved = retargetCard(card, NOTES, schema, 'apply') as Extract<AppCard, { kind: 'records' }>;
    expect(moved.source.tableId).toBe(NOTES);
    expect(moved.fieldIds).toEqual([FIELDS.note.id]);
    expect(moved.title).toBe('Notes');
    expect(moved.id).toBe(card.id);
    const titled = retargetCard({ ...card, title: 'Inbox' }, NOTES, schema, 'apply');
    expect(titled?.title).toBe('Inbox');
    expect(retargetCard(defaultCard('kanban', context('kanban'))!, NOTES, schema, 'apply')).toBeNull();
  });
});

describe('pages', () => {
  it('adds a page with a card (a page is never empty) and a fresh id', () => {
    const { spec, pageId } = addPage(specFixture(), 'Apply');
    expect(pageId).toBe('apply-2');
    expect(spec.pages.at(-1)).toMatchObject({ id: 'apply-2', title: 'Apply', cards: [{ kind: 'text' }] });
  });

  it('reorders, sets home, and deletes a page — roles stop listing it', () => {
    let spec = movePage(specFixture(), 'approve', 0);
    expect(spec.pages.map((page) => page.id)).toEqual(['approve', 'apply']);
    spec = setHome(spec, 'apply');
    expect(spec.home).toBe('apply');
    spec = setHome(spec, 'approve');
    // The first page is home already: no explicit home.
    expect(spec.home).toBeUndefined();
    const withExtra: AppSpec = {
      ...specFixture(),
      roles: [{ key: 'applicant', name: 'Applicant', pages: ['apply', 'approve'], tables: [] }],
      home: 'approve',
    };
    const after = deletePage(withExtra, 'approve');
    expect(after.pages.map((page) => page.id)).toEqual(['apply']);
    expect(after.roles[0]!.pages).toEqual(['apply']);
    expect(after.home).toBeUndefined();
  });

  it('refuses to delete a page that would leave a role with nothing, or that a button opens', () => {
    const spec = specFixture();
    expect(pageDeletionBlockers(spec, 'apply')).toEqual([
      { kind: 'onlyPageOfRole', roleKey: 'applicant', roleName: 'Applicant' },
    ]);
    const linked: AppSpec = {
      ...spec,
      pages: [
        spec.pages[0]!,
        {
          ...spec.pages[1]!,
          cards: [
            ...spec.pages[1]!.cards,
            {
              id: 'nav',
              kind: 'buttons',
              layout: { x: 0, y: 6, w: 6, h: 2 },
              buttons: [{ id: 'b', label: 'Go apply', type: 'open_page', pageId: 'apply' }],
            },
          ],
        },
      ],
    };
    expect(pageDeletionBlockers(linked, 'apply')).toContainEqual({
      kind: 'openedBy',
      pageId: 'approve',
      pageTitle: 'Approve',
      buttonLabel: 'Go apply',
    });
    expect(pageDeletionBlockers({ ...spec, pages: [spec.pages[0]!] }, 'apply')).toContainEqual({ kind: 'lastPage' });
  });
});

describe('action labels', () => {
  it('names each declared action id by its label, across cards and their details', () => {
    const spec = specFixture();
    const queue = spec.pages[1]!.cards[0] as Extract<AppCard, { kind: 'records' }>;
    queue.detail = {
      fieldIds: [1],
      actions: [{ id: 'reject', label: 'Reject', do: { type: 'delete' } }],
    };
    const mine = spec.pages[0]!.cards[0] as Extract<AppCard, { kind: 'records' }>;
    mine.actions = [{ id: 'approve', label: 'OK', do: { type: 'delete' } }];
    expect(actionLabelsById(spec)).toEqual(
      new Map([
        ['approve', 'OK / Approve'],
        ['reject', 'Reject'],
      ]),
    );
  });
});

describe('cards', () => {
  it('adds, lays out and removes cards, keeping the last one', () => {
    const card = defaultCard('kpi', context('kpi'))!;
    let spec = addCard(specFixture(), 'apply', card);
    expect(spec.pages[0]!.cards.map((entry) => entry.id)).toEqual(['mine', 'kpi-1']);
    spec = setCardLayouts(spec, 'apply', [{ id: 'kpi-1', x: 6, y: 0, w: 4, h: 3 }]);
    expect(spec.pages[0]!.cards[1]!.layout).toEqual({ x: 6, y: 0, w: 4, h: 3 });
    spec = removeCard(spec, 'apply', 'kpi-1');
    expect(spec.pages[0]!.cards.map((entry) => entry.id)).toEqual(['mine']);
    expect(removeCard(spec, 'apply', 'mine').pages[0]!.cards).toHaveLength(1);
  });
});

describe('roles', () => {
  it('adds a role that sees every page and no table', () => {
    const { spec, roleKey } = addRole(specFixture(), 'Finance team');
    expect(roleKey).toBe('finance-team');
    expect(spec.roles.at(-1)).toEqual({ key: 'finance-team', name: 'Finance team', pages: 'all', tables: [] });
  });

  it('deletes a role from every list that named it, leaving an empty list empty (nobody), never everyone', () => {
    const spec = specFixture();
    expect(roleListMentions(spec, 'approver')).toBe(1);
    const after = deleteRole(spec, 'approver');
    expect(after.roles.map((role) => role.key)).toEqual(['applicant']);
    const queue = after.pages[1]!.cards[0] as Extract<AppCard, { kind: 'records' }>;
    expect(queue.actions![0]!.roles).toEqual([]);
  });

  it('resolves who an action applies to: its roles, else the roles that see the page', () => {
    const spec = specFixture();
    expect(appliesTo(spec, 'apply', undefined).map((role) => role.key)).toEqual(['applicant', 'approver']);
    expect(appliesTo(spec, 'approve', undefined).map((role) => role.key)).toEqual(['approver']);
    expect(appliesTo(spec, 'approve', ['applicant']).map((role) => role.key)).toEqual(['applicant']);
  });
});

describe('page filters', () => {
  it('removes a filter and every condition that read it', () => {
    const spec = specFixture();
    const withFilter: AppSpec = {
      ...spec,
      pages: [
        {
          ...spec.pages[0]!,
          filters: [{ id: 'status', label: 'Status', kind: 'select', targets: [{ tableId: REQUESTS, fieldId: 3 }] }],
          cards: [
            {
              ...(spec.pages[0]!.cards[0] as Extract<AppCard, { kind: 'records' }>),
              source: {
                tableId: REQUESTS,
                query: {
                  where: { combinator: 'and', clauses: [{ fieldId: 2, operator: 'gt', value: 10 }] },
                  filters: [{ combinator: 'and', clauses: [{ fieldId: 3, operator: 'eq', value: pageRef('status') }] }],
                },
              },
            },
          ],
        },
        spec.pages[1]!,
      ],
    };
    const after = removePageFilter(withFilter, 'apply', 'status');
    expect(after.pages[0]!.filters).toBeUndefined();
    const card = after.pages[0]!.cards[0] as Extract<AppCard, { kind: 'records' }>;
    expect(card.source.query).toEqual({
      where: { combinator: 'and', clauses: [{ fieldId: 2, operator: 'gt', value: 10 }] },
    });
  });
});

describe('withList', () => {
  it('leaves an empty optional list out instead of storing it empty', () => {
    expect(withList({ fieldIds: [1], editableFieldIds: [2] }, 'editableFieldIds', [])).toEqual({ fieldIds: [1] });
    expect(
      withList({ fieldIds: [1] } as { fieldIds: number[]; editableFieldIds?: number[] }, 'editableFieldIds', [3]),
    ).toEqual({
      fieldIds: [1],
      editableFieldIds: [3],
    });
  });
});
