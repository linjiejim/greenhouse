import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HISTORY_FILTERS,
  countByFeedback,
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
    rating: null,
    comment: null,
    feedback: null,
    profile_id: 'team',
    metadata: '{}',
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

  it('matches groups, pins and the ungrouped bucket', () => {
    const all = [
      session({ id: 'pinned', pinned: true, group_id: 7 }),
      session({ id: 'filed', group_id: 7 }),
      session({ id: 'loose' }),
      session({ id: 'null-group', group_id: null }),
    ];
    expect(ids(filterSessions(all, filters({ group: 'pinned' })))).toEqual(['pinned']);
    expect(ids(filterSessions(all, filters({ group: 'g:7' })))).toEqual(['pinned', 'filed']);
    expect(ids(filterSessions(all, filters({ group: 'ungrouped' })))).toEqual(['loose', 'null-group']);
  });

  it('matches an exact rating, keeping unrated sessions out', () => {
    const all = [session({ id: 'three', rating: 3 }), session({ id: 'five', rating: 5 }), session({ id: 'none' })];
    expect(ids(filterSessions(all, filters({ rating: 3 })))).toEqual(['three']);
    expect(ids(filterSessions(all, filters({ rating: null })))).toEqual(['three', 'five', 'none']);
  });

  it('matches tags by id and tolerates sessions the API sent without any', () => {
    const all = [
      session({ id: 'tagged', tags: [{ id: 1, name: 'bug', color: '#f00' }] }),
      session({ id: 'other', tags: [{ id: 2, name: 'idea', color: '#0f0' }] }),
      session({ id: 'bare' }),
    ];
    expect(ids(filterSessions(all, filters({ tagId: 1 })))).toEqual(['tagged']);
  });

  it('searches title and comment case-insensitively', () => {
    const all = [
      session({ id: 'by-title', title: 'Nutrient Schedule' }),
      session({ id: 'by-comment', comment: 'follow up on NUTRIENT mix' }),
      session({ id: 'miss', title: 'Lighting' }),
    ];
    expect(ids(filterSessions(all, filters({ search: 'nutrient' })))).toEqual(['by-title', 'by-comment']);
  });

  it('ANDs every active filter together', () => {
    const all = [
      session({ id: 'hit', feedback: 'good', rating: 5, title: 'harvest plan', group_id: 3, is_owner: true }),
      session({ id: 'wrong-feedback', feedback: 'bad', rating: 5, title: 'harvest plan', group_id: 3 }),
      session({ id: 'wrong-group', feedback: 'good', rating: 5, title: 'harvest plan', group_id: 9 }),
      session({ id: 'wrong-title', feedback: 'good', rating: 5, title: 'seeding', group_id: 3 }),
    ];
    const combined = filters({ feedback: 'good', rating: 5, group: 'g:3', owner: 'mine', search: 'harvest' });
    expect(ids(filterSessions(all, combined))).toEqual(['hit']);
  });

  it('counts every status bucket and only the three feedback values', () => {
    const all = [
      session({ id: 'a', feedback: 'good' }),
      session({ id: 'b', status: 'archived', feedback: 'good' }),
      session({ id: 'c', status: 'archived', feedback: 'stale-value' }),
      session({ id: 'd', feedback: 'starred' }),
    ];
    expect(countByStatus(all)).toEqual({ active: 2, archived: 2 });
    expect(countByFeedback(all)).toEqual({ good: 2, bad: 0, starred: 1 });
  });

  it('counts what the collapsed row is hiding, ignoring status and search', () => {
    expect(countHiddenFilters(filters({ status: 'deleted', search: 'x' }))).toBe(0);
    expect(countHiddenFilters(filters({ feedback: 'good', rating: 4, tagId: 2 }))).toBe(3);
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
