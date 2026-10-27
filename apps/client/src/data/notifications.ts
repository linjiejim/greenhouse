/**
 * The notification list as the phone keeps it, pure (./notifications.test.ts): pages merged
 * without duplicates, newest first; read marks applied optimistically and undone when the server
 * refuses; and the offline copy (`toSnapshot` / `parseSnapshot`) the list opens with on a cold
 * start before the network answers.
 */

import type { PlatformNotification } from '../shared/greenhouse-types';

/** How many notifications the offline copy keeps. */
export const SNAPSHOT_MAX = 100;

export interface NotificationsSnapshot {
  v: 1;
  items: PlatformNotification[];
  nextCursor: string | null;
  unread: number;
  savedAt: number;
}

const byNewest = (a: PlatformNotification, b: PlatformNotification) =>
  b.created_at === a.created_at ? (b.id < a.id ? -1 : b.id > a.id ? 1 : 0) : b.created_at < a.created_at ? -1 : 1;

/**
 * A fresh first page over what is shown: the page wins for everything it covers; older items
 * already loaded beyond it stay (scroll position survives a pull to refresh).
 */
export function withFirstPage(current: readonly PlatformNotification[], page: readonly PlatformNotification[]) {
  if (page.length === 0) return [];
  const oldest = page[page.length - 1]!;
  const ids = new Set(page.map((item) => item.id));
  const tail = current.filter((item) => !ids.has(item.id) && byNewest(item, oldest) > 0);
  return [...page, ...tail].sort(byNewest);
}

/**
 * The list after a fresh first page, with a cursor that really continues it. Items loaded beyond
 * the page stay only when they came from this run's own paging (`continues`: their cursor is the
 * server's). An offline copy's tail does not — a cut copy has no cursor, and its older items may
 * be stale — so it is dropped and paging restarts from the page's own cursor.
 */
export function afterRefresh(input: {
  current: readonly PlatformNotification[];
  currentCursor: string | null;
  /** The items beyond the first page were paged in this run (not restored from the offline copy). */
  continues: boolean;
  page: readonly PlatformNotification[];
  pageCursor: string | null;
}): { items: PlatformNotification[]; nextCursor: string | null } {
  if (!input.continues) return { items: [...input.page], nextCursor: input.pageCursor };
  const items = withFirstPage(input.current, input.page);
  const keepsTail = items.length > input.page.length;
  return { items, nextCursor: keepsTail ? input.currentCursor : input.pageCursor };
}

/** A later page appended, without duplicates. */
export function withNextPage(current: readonly PlatformNotification[], page: readonly PlatformNotification[]) {
  const ids = new Set(current.map((item) => item.id));
  return [...current, ...page.filter((item) => !ids.has(item.id))].sort(byNewest);
}

/** One notification marked read (or replaced by the server's copy). */
export function withRead(current: readonly PlatformNotification[], id: string, readAt: string) {
  return current.map((item) => (item.id === id && !item.read_at ? { ...item, read_at: readAt } : item));
}

export function withAllRead(current: readonly PlatformNotification[], readAt: string) {
  return current.map((item) => (item.read_at ? item : { ...item, read_at: readAt }));
}

/** One notification put back as it was (a refused optimistic mark). */
export function withItem(current: readonly PlatformNotification[], next: PlatformNotification) {
  const found = current.some((item) => item.id === next.id);
  return found ? current.map((item) => (item.id === next.id ? next : item)) : withNextPage(current, [next]);
}

export function toSnapshot(input: {
  items: readonly PlatformNotification[];
  nextCursor: string | null;
  unread: number;
  now: number;
}): NotificationsSnapshot {
  const items = input.items.slice(0, SNAPSHOT_MAX);
  return {
    v: 1,
    items,
    // a cut list continues from the server's first page again, not from where the copy ends
    nextCursor: items.length < input.items.length ? null : input.nextCursor,
    unread: input.unread,
    savedAt: input.now,
  };
}

function isNotification(value: unknown): value is PlatformNotification {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.kind === 'string' &&
    typeof item.title === 'string' &&
    typeof item.body === 'string' &&
    typeof item.created_at === 'string' &&
    (item.read_at === null || typeof item.read_at === 'string')
  );
}

/** A stored copy, or null when it is not one (an older format, a corrupt file). */
export function parseSnapshot(value: unknown): NotificationsSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as Partial<NotificationsSnapshot>;
  if (snapshot.v !== 1 || !Array.isArray(snapshot.items) || !snapshot.items.every(isNotification)) return null;
  return {
    v: 1,
    items: snapshot.items.slice(0, SNAPSHOT_MAX),
    nextCursor: typeof snapshot.nextCursor === 'string' ? snapshot.nextCursor : null,
    unread: typeof snapshot.unread === 'number' && snapshot.unread >= 0 ? snapshot.unread : 0,
    savedAt: typeof snapshot.savedAt === 'number' ? snapshot.savedAt : 0,
  };
}
