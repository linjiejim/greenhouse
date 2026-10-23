/**
 * The notification center on the phone (Zustand): the list, the unread count (the app icon
 * badge and the drawer badge read it) and read marks.
 *
 * - Cache first: when a member signs in or the app starts, the offline copy of their list
 *   (../data/disk-cache.ts) is shown at once; the network answer replaces it and is saved again.
 * - Read marks are optimistic: the row turns read now and turns back when the server refuses.
 * - Everything belongs to one station + member: a switch or sign-out empties the store (module
 *   scope subscriptions below), and a late answer for a previous identity is dropped.
 */

import { create } from 'zustand';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationSummary,
} from '../api/notifications';
import { forgetMember, readCache, writeCache } from '../data/disk-cache';
import { captureIdentity } from '../data/identity';
import {
  afterRefresh,
  parseSnapshot,
  toSnapshot,
  withAllRead,
  withItem,
  withNextPage,
  withRead,
} from '../data/notifications';
import type { ApiMiss } from '../api/client';
import type { PlatformNotification } from '../shared/greenhouse-types';
import { useAuth } from './auth';
import { useStations } from './stations';

const CACHE_KIND = 'notifications';

interface NotificationsState {
  items: PlatformNotification[];
  nextCursor: string | null;
  /** -1 until known. */
  unread: number;
  /** `cached`: the offline copy is on screen and the network has not answered yet. */
  status: 'empty' | 'cached' | 'loading' | 'ready' | 'error';
  error: ApiMiss | null;
  loadingMore: boolean;
  /** The first page from the network (the offline copy first, when there is one). */
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  refreshSummary: () => Promise<void>;
  /** Mark one read (optimistic). False when the server refused. */
  markRead: (id: string) => Promise<boolean>;
  markAllRead: () => Promise<boolean>;
  /** One notification: from the list, else by marking it read (the server answers with it). */
  open: (id: string) => Promise<PlatformNotification | null>;
}

const INITIAL = {
  items: [] as PlatformNotification[],
  nextCursor: null,
  unread: -1,
  status: 'empty' as const,
  error: null,
  loadingMore: false,
};

/**
 * Bumped whenever the list is replaced wholesale (a refresh, an identity change): a page requested
 * against the previous list belongs to its continuation, so it is dropped instead of appended.
 */
let listEpoch = 0;

function identity(): { station: string; member: string } | null {
  const station = useStations.getState().activeId;
  const member = useAuth.getState().user?.id;
  return station && member ? { station, member } : null;
}

export const useNotifications = create<NotificationsState>((set, get) => {
  function save(): void {
    const who = identity();
    if (!who) return;
    const { items, nextCursor, unread } = get();
    writeCache(who.station, who.member, CACHE_KIND, toSnapshot({ items, nextCursor, unread, now: Date.now() }));
  }

  return {
    ...INITIAL,

    async refresh() {
      const current = captureIdentity();
      if (get().status === 'empty') set({ status: 'loading' });
      const [page, summary] = await Promise.all([listNotifications(), notificationSummary()]);
      if (!current()) return;
      if (!page.ok) {
        // Offline with a copy on screen: keep showing it (the screen says it is not current).
        const { items, status } = get();
        set({ status: items.length ? (status === 'cached' ? 'cached' : 'ready') : 'error', error: page });
        return;
      }
      const { items, nextCursor } = afterRefresh({
        current: get().items,
        currentCursor: get().nextCursor,
        // the offline copy's tail is not a server continuation (a cut copy has no cursor at all)
        continues: get().status === 'ready' || get().status === 'error',
        page: page.data.notifications,
        pageCursor: page.data.next_cursor,
      });
      listEpoch += 1;
      set({
        items,
        nextCursor,
        loadingMore: false,
        unread: summary.ok ? summary.data.unread : get().unread,
        status: 'ready',
        error: null,
      });
      save();
    },

    async loadMore() {
      const { nextCursor, loadingMore } = get();
      if (!nextCursor || loadingMore) return;
      const current = captureIdentity();
      const epoch = listEpoch;
      set({ loadingMore: true });
      const page = await listNotifications({ cursor: nextCursor });
      // the list was replaced meanwhile: this page continues the old one, not the new
      if (!current() || epoch !== listEpoch) return;
      if (!page.ok) {
        set({ loadingMore: false });
        return;
      }
      set({
        items: withNextPage(get().items, page.data.notifications),
        nextCursor: page.data.next_cursor,
        loadingMore: false,
      });
      save();
    },

    async refreshSummary() {
      const current = captureIdentity();
      const summary = await notificationSummary();
      if (current() && summary.ok) set({ unread: summary.data.unread });
    },

    async markRead(id) {
      const before = get().items.find((item) => item.id === id);
      if (before?.read_at) return true;
      const current = captureIdentity();
      set({
        items: withRead(get().items, id, new Date().toISOString()),
        unread: before && get().unread > 0 ? get().unread - 1 : get().unread,
      });
      const result = await markNotificationRead(id);
      if (!current()) return result.ok;
      if (!result.ok) {
        if (before) set({ items: withItem(get().items, before), unread: get().unread + 1 });
        return false;
      }
      set({ items: withItem(get().items, result.data.notification) });
      void get().refreshSummary();
      save();
      return true;
    },

    async markAllRead() {
      const before = { items: get().items, unread: get().unread };
      const current = captureIdentity();
      set({ items: withAllRead(get().items, new Date().toISOString()), unread: 0 });
      const result = await markAllNotificationsRead();
      if (!current()) return result.ok;
      if (!result.ok) {
        set(before);
        return false;
      }
      save();
      return true;
    },

    async open(id) {
      const known = get().items.find((item) => item.id === id);
      if (known) return known;
      const current = captureIdentity();
      // v1 has no single-notification read; marking it read answers with it (opening it reads it).
      const result = await markNotificationRead(id);
      if (!current() || !result.ok) return null;
      set({ items: withItem(get().items, result.data.notification) });
      void get().refreshSummary();
      return result.data.notification;
    },
  };
});

/** The offline copy for the identity now active, if the store is still empty for it. */
async function hydrateFromCache(): Promise<void> {
  const who = identity();
  if (!who) return;
  const current = captureIdentity();
  const snapshot = parseSnapshot(await readCache(who.station, who.member, CACHE_KIND));
  const { status } = useNotifications.getState();
  // only while the network has not answered for this identity yet
  if (!current() || !snapshot || (status !== 'empty' && status !== 'loading')) return;
  useNotifications.setState({
    items: snapshot.items,
    nextCursor: snapshot.nextCursor,
    unread: snapshot.unread,
    status: 'cached',
  });
}

// One station + member's notifications never survive into another's.
let owner = '';
function followIdentity(): void {
  const who = identity();
  const next = who ? `${who.station}:${who.member}` : '';
  if (next === owner) return;
  owner = next;
  listEpoch += 1;
  useNotifications.setState({ ...INITIAL });
  void hydrateFromCache();
}
useAuth.subscribe(followIdentity);
useStations.subscribe(followIdentity);

/** Sign-out: the member's offline copies go with their session. */
export function forgetOfflineCopies(stationId: string, memberId: string): void {
  forgetMember(stationId, memberId);
}
