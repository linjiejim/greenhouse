import { describe, expect, it } from 'vitest';
import type { ActivityItem } from '../shared/greenhouse-types';
import { beginActivityLoad, finishActivityLoad, NO_ACTIVITY, type ActivityFeedState } from './activity-feed';

const item = (id: string) => ({ id }) as ActivityItem;
const page = (ids: string[], next: string | null) => ({ ok: true as const, data: { items: ids.map(item), next_before: next } });

function loaded(ids: string[], next: string | null): ActivityFeedState {
  const first = beginActivityLoad(NO_ACTIVITY, false)!;
  return finishActivityLoad(first.state, first.load, page(ids, next));
}

describe('the team activity feed', () => {
  it('pages with the cursor the server handed back', () => {
    const state = loaded(['a', 'b'], 'c1');
    const more = beginActivityLoad(state, true)!;
    expect(more.load.before).toBe('c1');
    const next = finishActivityLoad(more.state, more.load, page(['c'], null));
    expect(next.items.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(next.next).toBeNull();
    expect(beginActivityLoad(next, true)).toBeNull();
  });

  it('drops a load-more that answers after a pull to refresh started', () => {
    const state = loaded(['a', 'b'], 'c1');
    const more = beginActivityLoad(state, true)!;
    const refresh = beginActivityLoad(more.state, false)!;
    expect(refresh.state.loadingMore).toBe(false);
    const fresh = finishActivityLoad(refresh.state, refresh.load, page(['z', 'a'], 'c2'));
    const late = finishActivityLoad(fresh, more.load, page(['old'], 'stale'));
    expect(late).toBe(fresh);
    expect(late.items.map((x) => x.id)).toEqual(['z', 'a']);
    expect(late.next).toBe('c2');
  });

  it('lets only the latest of two refreshes land', () => {
    const first = beginActivityLoad(NO_ACTIVITY, false)!;
    const second = beginActivityLoad(first.state, false)!;
    const landed = finishActivityLoad(second.state, second.load, page(['new'], null));
    expect(finishActivityLoad(landed, first.load, page(['old'], 'x'))).toBe(landed);
  });

  it('keeps what is shown when a load fails', () => {
    const state = loaded(['a'], 'c1');
    const more = beginActivityLoad(state, true)!;
    const failed = finishActivityLoad(more.state, more.load, { ok: false });
    expect(failed).toMatchObject({ items: [item('a')], loadingMore: false, status: 'ready' });
    const empty = beginActivityLoad(NO_ACTIVITY, false)!;
    expect(finishActivityLoad(empty.state, empty.load, { ok: false }).status).toBe('error');
  });
});
