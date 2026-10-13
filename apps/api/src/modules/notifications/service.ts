/**
 * In-app notifications: a pointer back to where something happened. Permanent and idempotent
 * (one per member and dedupe key); only the read state changes. Every source calls publish().
 */

import { and, count, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Notification, Page } from '@greenhouse/contract';
import { getDb, newId, notifications, requests, type NotificationKind, type NotificationRow } from '@greenhouse/db';
import { decodeCursor, toPage } from '../../http/pagination.js';
import type { Hub } from '../../realtime/hub.js';

export interface PublishInput {
  memberId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  targetType?: string;
  targetId?: string;
  requestId?: string;
  runId?: string;
  agentId?: string;
  /** Routing for push and channels; never message content. */
  payload?: Record<string, unknown>;
  dedupeKey: string;
}

const toNotification = (row: NotificationRow): Notification => ({
  id: row.id,
  kind: row.kind,
  title: row.title,
  body: row.body,
  target_type: row.targetType,
  target_id: row.targetId,
  request_id: row.requestId,
  run_id: row.runId,
  agent_id: row.agentId,
  read_at: row.readAt,
  created_at: row.createdAt,
});

export function createNotificationsService(deps: { hub: Hub }) {
  return {
    /** Records the notification once per dedupe key and tells the member's open screens. */
    async publish(input: PublishInput): Promise<Notification | null> {
      const [row] = await getDb()
        .insert(notifications)
        .values({
          id: newId('notification'),
          memberId: input.memberId,
          kind: input.kind,
          title: input.title,
          body: input.body ?? '',
          targetType: input.targetType ?? null,
          targetId: input.targetId ?? null,
          requestId: input.requestId ?? null,
          runId: input.runId ?? null,
          agentId: input.agentId ?? null,
          payload: input.payload ?? {},
          dedupeKey: input.dedupeKey,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) return null;
      deps.hub.publish([input.memberId], {
        type: 'notification.created',
        data: { notification_id: row.id, kind: row.kind, title: row.title },
      });
      return toNotification(row);
    },

    async list(
      memberId: string,
      query: { unread: 'true' | 'false'; cursor?: string; limit: number },
    ): Promise<Page<Notification>> {
      const before = decodeCursor(query.cursor);
      const rows = await getDb()
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.memberId, memberId),
            query.unread === 'true' ? isNull(notifications.readAt) : undefined,
            before ? lt(notifications.id, before) : undefined,
          ),
        )
        .orderBy(desc(notifications.id))
        .limit(query.limit + 1);
      return toPage(rows, query.limit, toNotification);
    },

    async markRead(memberId: string, input: { ids: string[] } | { all: true }): Promise<void> {
      await getDb()
        .update(notifications)
        .set({ readAt: sql`now()` })
        .where(
          and(
            eq(notifications.memberId, memberId),
            isNull(notifications.readAt),
            'ids' in input ? inArray(notifications.id, input.ids) : undefined,
          ),
        );
    },

    /** Notifications about a request are read once it is decided. */
    async markRequestRead(requestId: string): Promise<void> {
      await getDb()
        .update(notifications)
        .set({ readAt: sql`now()` })
        .where(and(eq(notifications.requestId, requestId), isNull(notifications.readAt)));
    },

    /** The one badge: what needs the member, else whether anything is unread. */
    async summary(memberId: string): Promise<{ needs_you: number; unread: number }> {
      const [[pending], [unread]] = await Promise.all([
        getDb()
          .select({ n: count() })
          .from(requests)
          .where(and(eq(requests.memberId, memberId), eq(requests.status, 'pending'))),
        getDb()
          .select({ n: count() })
          .from(notifications)
          .where(and(eq(notifications.memberId, memberId), isNull(notifications.readAt))),
      ]);
      return { needs_you: pending?.n ?? 0, unread: unread?.n ?? 0 };
    },
  };
}

export type NotificationsService = ReturnType<typeof createNotificationsService>;
