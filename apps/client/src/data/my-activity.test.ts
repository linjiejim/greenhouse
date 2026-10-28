import { describe, expect, it } from 'vitest';
import { joinActivityPage, myActivityQuery, type MyActivityItem } from './my-activity';

const item = (id: string): MyActivityItem => ({
  id,
  source: 'person',
  at: '2026-10-29T09:00:00Z',
  actor: { id: 'me', name: 'Jim' },
  agent: null,
  module: 'knowledge',
  verb: 'updated',
  entity: 'doc',
  action: 'updateDoc',
  action_title: null,
  target: null,
  run: null,
  detail: null,
});

describe('my activity', () => {
  it('asks for the window and source the member chose, never another person', () => {
    const now = Date.parse('2026-10-29T10:00:00.000Z');
    expect(myActivityQuery({ source: 'all', days: 30 }, now)).toEqual({ from: '2026-09-29T10:00:00.000Z' });
    const agent = myActivityQuery({ source: 'agent', days: 7 }, now);
    expect(agent).toEqual({ source: 'agent', from: '2026-10-22T10:00:00.000Z' });
    expect(Object.keys(agent)).not.toContain('user_id');
  });

  it('replaces the list on a first page and appends only new rows after', () => {
    const first = joinActivityPage([], { items: [item('a'), item('b')], next_cursor: 'c1' }, false);
    expect(first.map((row) => row.id)).toEqual(['a', 'b']);
    const more = joinActivityPage(first, { items: [item('b'), item('c')], next_cursor: null }, true);
    expect(more.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(joinActivityPage(more, { items: [item('z')], next_cursor: null }, false).map((row) => row.id)).toEqual([
      'z',
    ]);
  });
});
