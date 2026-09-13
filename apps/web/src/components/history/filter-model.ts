/**
 * The history browser's filter predicate, extracted from the UI.
 *
 * Everything here is pure so the combination logic (eight filters that AND
 * together) can be pinned by tests instead of by clicking through a modal.
 */

import type { Session, SessionTag } from '@greenhouse/types/api';

/**
 * The list endpoint enriches every session with its tags; `Session` itself doesn't
 * declare them, and the enrichment only carries the three display fields.
 */
export type HistorySessionTag = Pick<SessionTag, 'id' | 'name' | 'color'>;
export type HistorySession = Session & { tags?: HistorySessionTag[] };

export type FeedbackFilter = 'all' | 'good' | 'bad' | 'starred';
/**
 * Mirrors the sidebar's scope vocabulary. `team` exists because a super's list
 * contains other people's conversations, and those match neither 'mine' nor
 * 'shared' — before it existed they were reachable only via "all".
 */
export type OwnerFilter = 'all' | 'mine' | 'shared' | 'team';

export interface HistoryFilters {
  /** Sessions always belong to exactly one status bucket — this is a switch, not a filter. */
  status: string;
  feedback: FeedbackFilter;
  owner: OwnerFilter;
  /** 'all' | 'pinned' | 'ungrouped' | `g:<id>` */
  group: string;
  /** Profile id, or 'all'. Sessions without one count as 'team'. */
  profile: string;
  rating: number | null;
  tagId: number | null;
  search: string;
}

export const DEFAULT_HISTORY_FILTERS: HistoryFilters = {
  status: 'active',
  feedback: 'all',
  // Your own conversations, matching the sidebar. Widening to everyone's is a
  // deliberate act, not the state you land in.
  owner: 'mine',
  group: 'all',
  profile: 'all',
  rating: null,
  tagId: null,
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
  if (filters.feedback !== d.feedback) n++;
  if (filters.owner !== d.owner) n++;
  if (filters.group !== d.group) n++;
  if (filters.profile !== d.profile) n++;
  if (filters.rating !== d.rating) n++;
  if (filters.tagId !== d.tagId) n++;
  return n;
}

export function countByStatus(sessions: HistorySession[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of sessions) counts[s.status] = (counts[s.status] || 0) + 1;
  return counts;
}

export function countByFeedback(sessions: HistorySession[]): Record<string, number> {
  const counts: Record<string, number> = { good: 0, bad: 0, starred: 0 };
  for (const s of sessions) {
    if (s.feedback && counts[s.feedback] !== undefined) counts[s.feedback]++;
  }
  return counts;
}

export function filterSessions(sessions: HistorySession[], filters: HistoryFilters): HistorySession[] {
  let result = sessions.filter((s) => s.status === filters.status);

  if (filters.feedback !== 'all') {
    result = result.filter((s) => s.feedback === filters.feedback);
  }
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
  if (filters.rating != null) {
    result = result.filter((s) => s.rating === filters.rating);
  }
  if (filters.tagId != null) {
    result = result.filter((s) => s.tags?.some((tag) => tag.id === filters.tagId));
  }
  if (filters.group === 'pinned') {
    result = result.filter((s) => s.pinned === true);
  } else if (filters.group === 'ungrouped') {
    result = result.filter((s) => s.group_id == null);
  } else if (filters.group.startsWith('g:')) {
    const groupId = parseInt(filters.group.slice(2), 10);
    result = result.filter((s) => s.group_id === groupId);
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    result = result.filter(
      (s) => (s.title || '').toLowerCase().includes(q) || (s.comment || '').toLowerCase().includes(q),
    );
  }
  return result;
}
