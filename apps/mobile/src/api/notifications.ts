/**
 * The platform notification center — `/api/notifications` (route:
 * apps/api/src/routes/notifications.ts): the member's notifications newest
 * first, keyset-paged, and marking them read. The inbox (`app/inbox.tsx`) is a
 * minimal list of them; a row opens what it is about the way its push would
 * (src/inbox/model.ts).
 */

import { read, write, type Fetch, type Write } from './tables';

/** One notification as the list answers it (`PlatformNotification` in packages/types/src/notification.ts). */
export interface InboxNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  payload: unknown;
  run_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface InboxPage {
  notifications: InboxNotification[];
  next_cursor: string | null;
}

export function listNotifications(cursor?: string | null): Promise<Fetch<InboxPage>> {
  const q = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
  return read(`/api/notifications?limit=30${q}`, (body) => ({
    notifications: (body?.notifications ?? []) as InboxNotification[],
    next_cursor: (body?.next_cursor ?? null) as string | null,
  }));
}

export function markNotificationRead(id: string): Promise<Write<null>> {
  return write(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }, () => null);
}

export function markAllNotificationsRead(): Promise<Write<number>> {
  return write('/api/notifications/read-all', { method: 'POST' }, (body) => Number(body?.marked ?? 0));
}
