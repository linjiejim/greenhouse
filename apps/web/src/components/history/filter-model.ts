/**
 * The history browser's filter predicate, extracted from the UI.
 *
 * Everything here is pure so the combination logic (filters that AND
 * together) can be pinned by tests instead of by clicking through a modal.
 */

import type { Session } from '@greenhouse/types/api';

export type HistorySession = Session;

/**
 * Mirrors the sidebar's scope vocabulary. `team` exists because a super's list
 * contains other people's conversations, and those match neither 'mine' nor
 * 'shared' — before it existed they were reachable only via "all".
 */
export type OwnerFilter = 'all' | 'mine' | 'shared' | 'team';

export interface HistoryFilters {
  /** Sessions always belong to exactly one status bucket — this is a switch, not a filter. */
  status: string;
  owner: OwnerFilter;
  /** 'all' | 'pinned' */
  group: string;
  /** Profile id, or 'all'. Sessions without one count as 'team'. */
  profile: string;
  search: string;
}

export const DEFAULT_HISTORY_FILTERS: HistoryFilters = {
  status: 'active',
  // Your own conversations, matching the sidebar. Widening to everyone's is a
  // deliberate act, not the state you land in.
  owner: 'mine',
  group: 'all',
  profile: 'all',
  search: '',
};

/**
 * Filters that live behind "More" — counted so the collapsed row can say how
 * many are hiding. Counted as "differs from the default" rather than "is not
 * 'all'", so the default ownership doesn't permanently light up the badge.
 */
export function countHiddenFilters(filters: HistoryFilters): number {
  const d = DEFAULT_HISTORY_FILTERS;
  let n = 0;
  if (filters.owner !== d.owner) n++;
  if (filters.group !== d.group) n++;
  if (filters.profile !== d.profile) n++;
  return n;
}

export function countByStatus(sessions: HistorySession[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of sessions) counts[s.status] = (counts[s.status] || 0) + 1;
  return counts;
}

export function filterSessions(sessions: HistorySession[], filters: HistoryFilters): HistorySession[] {
  let result = sessions.filter((s) => s.status === filters.status);

  if (filters.profile !== 'all') {
    result = result.filter((s) => (s.profile_id || 'team') === filters.profile);
  }
  if (filters.owner === 'mine') {
    result = result.filter((s) => s.is_owner !== false);
  } else if (filters.owner === 'shared') {
    result = result.filter((s) => s.shared === true);
  } else if (filters.owner === 'team') {
    result = result.filter((s) => s.is_owner === false && s.shared !== true);
  }
  if (filters.group === 'pinned') {
    result = result.filter((s) => s.pinned === true);
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    result = result.filter((s) => (s.title || '').toLowerCase().includes(q));
  }
  return result;
}
