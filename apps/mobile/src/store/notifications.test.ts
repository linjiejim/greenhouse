/**
 * The notification store (./notifications.ts) against overlapping requests: a page requested
 * against the offline copy must not be appended after a refresh replaced that list (it would skip
 * or duplicate rows). Runs in the ROOT vitest unit project with zustand, the API, the offline
 * copy and the identity stores mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformNotification } from '../shared/greenhouse-types';

vi.mock('zustand', () => ({
  create: <S extends object>(init: (set: (p: Partial<S>) => void, get: () => S) => S) => {
    let state: S;
    const get = () => state;
    const set = (partial: Partial<S>) => {
      state = { ...state, ...partial };
    };
    state = init(set, get);
    return Object.assign(() => state, { getState: get, setState: set });
  },
}));
vi.mock('./auth', () => ({ useAuth: { getState: () => ({ user: { id: 'u1' } }), subscribe: () => () => {} } }));
vi.mock('./stations', () => ({ useStations: { getState: () => ({ activeId: 'st-a' }), subscribe: () => () => {} } }));
vi.mock('../data/identity', () => ({ captureIdentity: () => () => true }));
vi.mock('../data/disk-cache', () => ({ readCache: async () => null, writeCache: () => {}, forgetMember: () => {} }));

const pending: Record<string, (value: unknown) => void> = {};
vi.mock('../api/notifications', () => ({
  listNotifications: (query: { cursor?: string | null } = {}) =>
    new Promise((resolve) => {
      pending[query.cursor ? `page:${query.cursor}` : 'first'] = resolve;
    }),
  notificationSummary: async () => ({ ok: true, data: { unread: 0 } }),
  markNotificationRead: async () => ({ ok: false }),
  markAllNotificationsRead: async () => ({ ok: false }),
}));

const { useNotifications } = await import('./notifications');

function note(n: number): PlatformNotification {
  return {
    id: `ntf_${String(n).padStart(3, '0')}`,
    user_id: 'u1',
    kind: 'system',
    title: `T${n}`,
    body: '',
    payload: {},
    run_id: null,
    interrupt_id: null,
    event_id: null,
    agent_id: null,
    read_at: null,
    created_at: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
  };
}
const ok = (items: PlatformNotification[], cursor: string | null) => ({
  ok: true,
  data: { notifications: items, next_cursor: cursor },
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  for (const key of Object.keys(pending)) delete pending[key];
});

describe('paging against a replaced list', () => {
  it('drops a page of the offline copy that lands after a refresh replaced it', async () => {
    // the offline copy: 3 rows, continuing at its own cursor
    useNotifications.setState({ items: [note(9), note(8), note(7)], nextCursor: 'cached-7', status: 'cached' });
    const more = useNotifications.getState().loadMore();
    const refresh = useNotifications.getState().refresh();
    await flush();
    // the refresh answers first: a fresh list with its own continuation
    pending.first!(ok([note(10), note(9)], 'fresh-9'));
    await refresh;
    // then the stale page of the old copy lands
    pending['page:cached-7']!(ok([note(6), note(5)], 'cached-5'));
    await more;
    const { items, nextCursor, loadingMore } = useNotifications.getState();
    expect(items.map((i) => i.id)).toEqual([note(10).id, note(9).id]);
    expect(nextCursor).toBe('fresh-9');
    expect(loadingMore).toBe(false);
  });

  it('appends a page that continues the current list', async () => {
    useNotifications.setState({ items: [note(9)], nextCursor: 'c-9', status: 'ready', loadingMore: false });
    const more = useNotifications.getState().loadMore();
    await flush();
    pending['page:c-9']!(ok([note(8)], null));
    await more;
    expect(useNotifications.getState().items.map((i) => i.id)).toEqual([note(9).id, note(8).id]);
  });
});
