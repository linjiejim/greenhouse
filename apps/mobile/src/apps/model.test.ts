/**
 * Reading an app's (role-trimmed) spec on the phone (./model.ts): pages and
 * cards, opening a record, what each write asks for and may send, who may
 * move a lane, and which actions ask first.
 */

import { describe, expect, it } from 'vitest';

import type { AppCard, AppRuntimeView, AppSpec } from '../shared/apps';
import {
  actionConfirmation,
  actionInputs,
  canMove,
  cardsInOrder,
  isMobileCard,
  MANAGER_ROLE,
  pageFor,
  recordActions,
  recordCardCandidates,
  refusalOf,
  writableFieldIds,
  writeTarget,
} from './model';

const layout = (y: number, x = 0) => ({ x, y, w: 6, h: 4 });
const field = (id: number, editable: boolean) => ({
  id,
  name: `F${id}`,
  type: 'text',
  isPrimary: id === 1,
  config: {},
  editable,
});
const approve = {
  id: 'approve',
  label: 'Approve',
  do: { type: 'set_fields' as const, values: [{ fieldId: 3, value: 'approved' }] },
};
const reject = {
  id: 'reject',
  label: 'Reject',
  do: {
    type: 'set_fields' as const,
    values: [{ fieldId: 3, value: 'rejected' }],
    inputFieldIds: [9],
    requiredInputFieldIds: [9],
  },
};
const mine: AppCard = {
  id: 'mine',
  layout: layout(0),
  kind: 'records',
  source: { tableId: 1 },
  fieldIds: [1, 2],
  detail: { fieldIds: [1, 2] },
  create: { fieldIds: [1, 2], defaults: [{ fieldId: 4, value: '$me' }] },
};
const board: AppCard = {
  id: 'queue',
  layout: layout(2),
  kind: 'kanban',
  source: { tableId: 1 },
  groupFieldId: 3,
  fieldIds: [1],
  detail: { fieldIds: [1, 3] },
  actions: [approve, reject],
  move: { roles: ['approver'] },
};
const stats: AppCard = { id: 'stats', layout: layout(1), kind: 'kpi', card: { kind: 'kpi', source: { tableId: 1 } } };
const form: AppCard = {
  id: 'new',
  layout: layout(0, 6),
  kind: 'form',
  tableId: 1,
  fieldIds: [1, 2],
  defaults: [{ fieldId: 5, value: 'x' }],
};
const vendors: AppCard = {
  id: 'vendors',
  layout: layout(0),
  kind: 'records',
  source: { tableId: 2 },
  fieldIds: [7],
  detail: { fieldIds: [7] },
};

const spec: AppSpec = {
  version: 1,
  home: 'approve',
  pages: [
    { id: 'requests', title: 'My requests', cards: [board, stats, mine, form] },
    { id: 'approve', title: 'Approve', cards: [vendors, board] },
  ],
  roles: [{ key: 'approver', name: 'Approver', pages: 'all', tables: [] }],
};

describe('pages and cards', () => {
  it('opens the asked page, else home, else the first', () => {
    expect(pageFor(spec, 'requests')?.id).toBe('requests');
    expect(pageFor(spec, 'nope')?.id).toBe('approve');
    expect(pageFor({ ...spec, home: undefined }, null)?.id).toBe('requests');
  });

  it('reads cards top to bottom, left to right', () => {
    expect(cardsInOrder(spec.pages[0]!).map((card) => card.id)).toEqual(['mine', 'new', 'stats', 'queue']);
  });

  it('knows which kinds this build draws', () => {
    expect(isMobileCard('kanban')).toBe(true);
    expect(isMobileCard('custom_widget')).toBe(false);
  });
});

describe('opening a record from a push', () => {
  it('prefers a card on the named page reading the record’s table', () => {
    expect(recordCardCandidates(spec, 'approve', 1)).toEqual([
      { pageId: 'approve', cardId: 'queue' },
      { pageId: 'requests', cardId: 'mine' },
      { pageId: 'requests', cardId: 'queue' },
    ]);
    // the table unknown: every card with a detail view, the named page's first
    expect(recordCardCandidates(spec, 'approve', null).slice(0, 2)).toEqual([
      { pageId: 'approve', cardId: 'vendors' },
      { pageId: 'approve', cardId: 'queue' },
    ]);
    expect(recordCardCandidates(spec, null, 99)).toEqual([]);
  });
});

describe('writes', () => {
  it('shows the actions the gateway says hold for this record', () => {
    expect(recordActions(board.kind === 'kanban' ? board.actions : [], ['reject']).map((a) => a.id)).toEqual([
      'reject',
    ]);
    expect(actionInputs(reject)).toEqual({ fieldIds: [9], required: [9] });
    expect(actionInputs(approve)).toBeNull();
  });

  it('names the fields and the gateway action of each write form', () => {
    expect(writeTarget(form, 'submit')).toEqual({
      tableId: 1,
      fieldIds: [1, 2],
      defaults: [{ fieldId: 5, value: 'x' }],
      actionId: '$submit',
      required: [],
    });
    expect(writeTarget(mine, 'create')?.actionId).toBe('$create');
    expect(writeTarget(board, 'action', { actionId: 'reject' })).toMatchObject({
      fieldIds: [9],
      actionId: 'reject',
      required: [9],
    });
    expect(writeTarget(board, 'action', { actionId: 'approve' })).toBeNull();
    expect(writeTarget(stats, 'submit')).toBeNull();
  });

  it('moves lanes only for the roles the card allows, and only when the role may write the lane field', () => {
    const as = (key: string, laneEditable = true): Pick<AppRuntimeView, 'role' | 'tables'> => ({
      role: { key, name: key },
      tables: [{ id: 1, name: 'Requests', fields: [field(1, true), field(3, laneEditable)] }],
    });
    expect(canMove(board, as('approver'))).toBe(true);
    expect(canMove(board, as('requester'))).toBe(false);
    expect(canMove(board, as(MANAGER_ROLE))).toBe(true);
    expect(canMove(mine, as('approver'))).toBe(false);
    // `$move` writes the lane field: a role that only reads it gets no "Move to" (the gateway would refuse).
    expect(canMove(board, as('approver', false))).toBe(false);
    expect(canMove({ ...board, move: {} } as AppCard, as('requester', false))).toBe(false);
  });

  it('offers a write only the fields the role may write', () => {
    const view = { tables: [{ id: 1, name: 'Requests', fields: [field(1, true), field(2, false), field(4, true)] }] };
    expect(writableFieldIds(view, 1, [4, 2, 1, 8])).toEqual([4, 1]);
    expect(writableFieldIds(view, 9, [1])).toEqual([]);
  });

  it('asks before an action the builder asked for, and always before a delete', () => {
    expect(actionConfirmation(approve)).toBeNull();
    expect(actionConfirmation({ ...approve, confirm: 'Approve the purchase?' })).toEqual({
      message: 'Approve the purchase?',
      destructive: false,
    });
    const remove = { id: 'remove', label: 'Delete', do: { type: 'delete' as const } };
    expect(actionConfirmation(remove)).toEqual({ message: null, destructive: true });
    expect(actionConfirmation({ ...remove, confirm: 'Gone for good?' })).toEqual({
      message: 'Gone for good?',
      destructive: true,
    });
  });

  it('reads why the gateway refused', () => {
    expect(refusalOf({ reason: 'precondition' }, 409)).toBe('precondition');
    expect(refusalOf(undefined, 404)).toBe('not_found');
    expect(refusalOf({ reason: 'weird' }, 500)).toBeNull();
  });
});
