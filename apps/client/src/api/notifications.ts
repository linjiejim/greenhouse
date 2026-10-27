/**
 * The notification center (`/api/notifications`, apps/api/src/routes/notifications.ts): the list
 * (newest first, cursor pages, optionally unread only), the unread count and marking read.
 * Every call answers an `ApiResult` (./client.ts), never throws.
 */

import type {
  PlatformNotification,
  PlatformNotificationList,
  PlatformNotificationSummary,
} from '../shared/greenhouse-types';
import { get, post, seg } from './client';

export const NOTIFICATION_PAGE_SIZE = 30;

export const listNotifications = (query: { unreadOnly?: boolean; cursor?: string | null; limit?: number } = {}) =>
  get<PlatformNotificationList>('/api/notifications', {
    limit: query.limit ?? NOTIFICATION_PAGE_SIZE,
    cursor: query.cursor ?? undefined,
    unread_only: query.unreadOnly ? '1' : undefined,
  });

export const notificationSummary = () => get<PlatformNotificationSummary>('/api/notifications/summary');

/** One notification read; the answer is the notification as it is now. */
export const markNotificationRead = (id: string) =>
  post<{ notification: PlatformNotification }>(`/api/notifications/${seg(id)}/read`);

/** Every notification read; the answer says how many changed. */
export const markAllNotificationsRead = () => post<{ marked: number }>('/api/notifications/read-all');
