import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HISTORY_FILTERS,
  countByStatus,
  countHiddenFilters,
  filterSessions,
  type HistoryFilters,
  type HistorySession,
} from './filter-model';

function session(overrides: Partial<HistorySession> & { id: string }): HistorySession {
  return {
    title: null,
    status: 'active',
    profile_id: 'team',
    metadata: {},
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

const filters = (patch: Partial<HistoryFilters> = {}): HistoryFilters => ({ ...DEFAULT_HISTORY_FILTERS, ...patch });

const ids = (list: HistorySession[]) => list.map((s) => s.id);

describe('history filter model', () => {
  it('shows only the selected status bucket', () => {
    const all = [
      session({ id: 'a' }),
      session({ id: 'b', status: 'archived' }),
      session({ id: 'c', status: 'deleted' }),
    ];
    expect(ids(filterSessions(all, filters()))).toEqual(['a']);
    expect(ids(filterSessions(all, filters({ status: 'deleted' })))).toEqual(['c']);
  });

  it('treats a missing profile as the team profile', () => {
    const all = [session({ id: 'a', profile_id: '' }), session({ id: 'b', profile_id: 'sprouty' })];
    expect(ids(filterSessions(all, filters({ profile: 'team' })))).toEqual(['a']);
    expect(ids(filterSessions(all, filters({ profile: 'sprouty' })))).toEqual(['b']);
  });

  it('separates sessions I own, shared with me, and everyone else’s', () => {
    const all = [
      session({ id: 'mine', is_owner: true }),
      session({ id: 'legacy' }), // is_owner absent — the API omits it, and that must not read as "not mine"
      session({ id: 'theirs', is_owner: false, shared: true }),
      // A super's list carries this: someone else's, never shared. Before the
      // 'team' bucket existed it matched neither 'mine' nor 'shared'.
      session({ id: 'someone-elses', is_owner: false }),
    ];
    expect(ids(filterSessions(all, filters({ owner: 'mine' })))).toEqual(['mine', 'legacy']);
    expect(ids(filterSessions(all, filters({ owner: 'shared' })))).toEqual(['theirs']);
    expect(ids(filterSessions(all, filters({ owner: 'team' })))).toEqual(['someone-elses']);
    expect(ids(filterSessions(all, filters({ owner: 'all' })))).toHaveLength(4);
  });

  it('matches pinned sessions', () => {
    const all = [session({ id: 'pinned', pinned: true }), session({ id: 'loose' })];
    expect(ids(filterSessions(all, filters({ group: 'pinned' })))).toEqual(['pinned']);
    expect(ids(filterSessions(all, filters({ group: 'all' })))).toEqual(['pinned', 'loose']);
  });

  it('searches the title case-insensitively', () => {
    const all = [session({ id: 'by-title', title: 'Nutrient Schedule' }), session({ id: 'miss', title: 'Lighting' })];
    expect(ids(filterSessions(all, filters({ search: 'nutrient' })))).toEqual(['by-title']);
  });

  it('ANDs every active filter together', () => {
    const all = [
      session({ id: 'hit', title: 'harvest plan', pinned: true, is_owner: true }),
      session({ id: 'not-mine', title: 'harvest plan', pinned: true, is_owner: false }),
      session({ id: 'not-pinned', title: 'harvest plan' }),
      session({ id: 'wrong-title', title: 'seeding', pinned: true }),
    ];
    const combined = filters({ group: 'pinned', owner: 'mine', search: 'harvest' });
    expect(ids(filterSessions(all, combined))).toEqual(['hit']);
  });

  it('counts every status bucket', () => {
    const all = [
      session({ id: 'a' }),
      session({ id: 'b', status: 'archived' }),
      session({ id: 'c', status: 'archived' }),
      session({ id: 'd' }),
    ];
    expect(countByStatus(all)).toEqual({ active: 2, archived: 2 });
  });

  it('counts what the collapsed row is hiding, ignoring status and search', () => {
    expect(countHiddenFilters(filters({ status: 'deleted', search: 'x' }))).toBe(0);
    expect(countHiddenFilters(filters({ owner: 'all', group: 'pinned', profile: 'sprouty' }))).toBe(3);
  });

  it('does not count the default ownership as an active filter', () => {
    // 'mine' is the default now, so counting "not all" would light the badge up
    // permanently and stop meaning anything.
    expect(countHiddenFilters(filters({ owner: 'mine' }))).toBe(0);
    expect(countHiddenFilters(filters({ owner: 'all' }))).toBe(1);
    expect(countHiddenFilters(filters({ owner: 'team' }))).toBe(1);
  });
});
