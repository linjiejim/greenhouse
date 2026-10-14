import { describe, expect, it } from 'vitest';
import type { Base, BaseTable } from '../shared/contract';
import { mayEdit, changedValues, cellText, choiceValue, agendaGroups } from './model';
describe('record editing', () => {
  it('respects custom table permission and archived bases', () => {
    const b = { access: 'viewer', custom_role: { id: 'role' }, archived_at: null } as Base;
    expect(mayEdit(b, { access: 'edit' } as BaseTable)).toBe(true);
    expect(mayEdit(b, { access: 'read' } as BaseTable)).toBe(false);
    expect(mayEdit({ ...b, archived_at: 'now' }, { access: 'edit' } as BaseTable)).toBe(false);
  });
  it('sends only changes so hidden and computed values are not echoed', () => {
    expect(changedValues({ a: 'old', calc: 9 }, { a: 'new', calc: 9 })).toEqual({ a: 'new' });
  });
  it('shows option labels and linked titles, never their ids', () => {
    expect(
      cellText(
        { type: 'single_select', config: { options: [{ id: 'option', label: 'Done', color: 'green' }] } },
        'option',
      ),
    ).toBe('Done');
    expect(
      cellText({ type: 'relation', config: {} }, ['r1'], {
        linked: { r1: { title: 'Task', table_id: 't' } },
        files: {},
      }),
    ).toBe('Task');
  });
});

it('keeps single member and record picks in their contract list shapes', () => {
  for (const type of ['member', 'relation', 'parent', 'dependency'] as const) {
    expect(choiceValue({ type }, 'id')).toEqual(['id']);
    expect(choiceValue({ type }, '')).toEqual([]);
  }
  expect(choiceValue({ type: 'single_select' }, 'option')).toBe('option');
});

it('groups date-times by the member calendar day without shifting date-only values', () => {
  const rows = [
    { id: 'a', values: { date: '2026-10-15T20:00:00Z' } },
    { id: 'b', values: { date: '2026-10-16' } },
  ] as unknown as import('../shared/contract').TableRecord[];
  expect(agendaGroups(rows, 'date', 'Asia/Taipei')).toEqual([{ key: '2026-10-16', items: rows }]);
});
