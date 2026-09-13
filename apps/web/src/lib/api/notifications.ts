/** Platform notification center API. */

import type {
  PlatformNotification,
  PlatformNotificationList,
  PlatformNotificationSummary,
} from '@greenhouse/types/notification';

import { fetchJson } from '../http';

export async function fetchNotifications(
  input: {
    cursor?: string | null;
    limit?: number;
    unreadOnly?: boolean;
  } = {},
): Promise<PlatformNotificationList> {
  const params = new URLSearchParams();
  if (input.cursor) params.set('cursor', input.cursor);
  if (input.limit) params.set('limit', String(input.limit));
  if (input.unreadOnly) params.set('unread_only', '1');
  const query = params.size > 0 ? `?${params.toString()}` : '';
  return fetchJson<PlatformNotificationList>(`/api/notifications${query}`);
}

export async function fetchNotificationSummary(): Promise<PlatformNotificationSummary> {
  return fetchJson<PlatformNotificationSummary>('/api/notifications/summary');
}

export async function markNotificationRead(notificationId: string): Promise<PlatformNotification> {
  return (
    await fetchJson<{ notification: PlatformNotification }>(
      `/api/notifications/${encodeURIComponent(notificationId)}/read`,
      { method: 'POST' },
    )
  ).notification;
}

export async function markAllNotificationsRead(): Promise<number> {
  return (await fetchJson<{ marked: number }>('/api/notifications/read-all', { method: 'POST' })).marked;
}
