/**
 * The team activity feed's paging state, pure (./activity-feed.test.ts). Every load carries the
 * generation it started in; a refresh starts a new generation, so a load-more still in flight
 * when the member pulls to refresh (or an older refresh) lands on a list it no longer belongs to
 * and is dropped instead of appending a stale page and overwriting the cursor.
 */

import type { ActivityItem, RecentChangesPage } from '../shared/greenhouse-types';

export interface ActivityFeedState {
  items: ActivityItem[];
  /** The server's opaque `next_before`; null when there is nothing older. */
  next: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  loadingMore: boolean;
  generation: number;
}

export interface ActivityLoad {
  more: boolean;
  generation: number;
  before: string | null;
}

export const NO_ACTIVITY: ActivityFeedState = { items: [], next: null, status: 'idle', loadingMore: false, generation: 0 };

/** The load to start (and the state while it runs), or null when a load-more has nothing to do. */
export function beginActivityLoad(state: ActivityFeedState, more: boolean): { state: ActivityFeedState; load: ActivityLoad } | null {
  if (more) {
    if (!state.next || state.loadingMore || state.status !== 'ready') return null;
    return { state: { ...state, loadingMore: true }, load: { more, generation: state.generation, before: state.next } };
  }
  const generation = state.generation + 1;
  return {
    state: { ...state, generation, loadingMore: false, status: state.items.length ? state.status : 'loading' },
    load: { more, generation, before: null },
  };
}

/** The state after a load answered; an answer from an earlier generation changes nothing. */
export function finishActivityLoad(
  state: ActivityFeedState,
  load: ActivityLoad,
  result: { ok: true; data: RecentChangesPage } | { ok: false },
): ActivityFeedState {
  if (load.generation !== state.generation) return state;
  if (!result.ok) {
    return load.more ? { ...state, loadingMore: false } : { ...state, status: state.items.length ? 'ready' : 'error' };
  }
  const items = load.more ? [...state.items, ...result.data.items] : result.data.items;
  return { ...state, items, next: result.data.next_before, status: 'ready', loadingMore: false };
}
