/**
 * The notification center on API v2 (`/api/notifications`): the list (all, or unread), the one
 * badge's numbers (`summary`: needs-you count and unread) and marking read.
 * Every call answers an `ApiResult` (./client.ts), never throws.
 */

import type { Notification, Page } from '../shared/contract';
import { get, post } from './client';

export interface NotificationSummary {
  /** Pending requests for widget synchronization; notification badges use unread. */
  needs_you: number;
  unread: number;
}

export const listNotifications = (query: { unread?: boolean; cursor?: string; limit?: number } = {}) =>
  get<Page<Notification>>('/api/notifications', { ...query, unread: query.unread ? 'true' : undefined });

export const notificationSummary = () => get<NotificationSummary>('/api/notifications/summary');

/** Some, or every, notification read. */
export const markNotificationsRead = (input: { ids: string[] } | { all: true }) =>
  post<void>('/api/notifications/read', input);
