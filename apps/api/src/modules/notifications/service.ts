/**
 * In-app notifications: a pointer back to where something happened. Idempotent
 * (one per member and dedupe key); settled request pointers are cleared. Every source calls publish(),
 * which also queues the delivery to the member's other channels in the same transaction.
 */

import { and, count, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Notification, Page } from '@greenhouse/contract';
import {
  getDb,
  newId,
  notifications,
  requests,
  transaction,
  type NotificationKind,
  type NotificationRow,
} from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { decodeCursor, toPage } from '../../http/pagination.js';
import type { Hub } from '../../realtime/hub.js';
import type { Deliveries } from '../channels/service.js';

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

export function createNotificationsService(deps: { hub: Hub; deliveries: Deliveries }) {
  /** The member's other screens refresh their badge and list. */
  function announceRead(memberId: string, read: Array<{ id: string }>) {
    if (!read.length) return;
    deps.hub.publish([memberId], {
      type: 'notification.read',
      data: { notification_ids: read.map((row) => row.id) },
    });
  }

  return {
    /**
     * Records the notification once per dedupe key, with its deliveries to the member's other
     * channels in the same transaction, and tells the member's open screens.
     */
    async publish(input: PublishInput): Promise<Notification | null> {
      const row = await transaction(async (db) => {
        const [created] = await db
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
        // In a savepoint: a delivery that cannot be queued never costs the in-app notification.
        if (created) {
          await transaction(() => deps.deliveries.enqueue(created)).catch((error: unknown) =>
            logger.warn('[notifications] could not queue the deliveries', {
              notification: created.id,
              error: toErrorMessage(error),
            }),
          );
        }
        return created ?? null;
      });
      if (!row) return null;
      deps.hub.publish([input.memberId], {
        type: 'notification.created',
        data: { notification_id: row.id, kind: row.kind, title: row.title },
      });
      deps.deliveries.wake();
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
            isNull(notifications.clearedAt),
            query.unread === 'true' ? isNull(notifications.readAt) : undefined,
            before ? lt(notifications.id, before) : undefined,
          ),
        )
        .orderBy(desc(notifications.id))
        .limit(query.limit + 1);
      return toPage(rows, query.limit, toNotification);
    },

    async markRead(memberId: string, input: { ids: string[] } | { all: true }): Promise<void> {
      const read = await getDb()
        .update(notifications)
        .set({ readAt: sql`now()` })
        .where(
          and(
            eq(notifications.memberId, memberId),
            isNull(notifications.clearedAt),
            isNull(notifications.readAt),
            'ids' in input ? inArray(notifications.id, input.ids) : undefined,
          ),
        )
        .returning({ id: notifications.id });
      announceRead(memberId, read);
    },

    /** Reading a conversation reads its reply and mention notifications up to where the member read. */
    async markConversationRead(memberId: string, conversationId: string, seq: number): Promise<void> {
      const read = await getDb()
        .update(notifications)
        .set({ readAt: sql`now()` })
        .where(
          and(
            eq(notifications.memberId, memberId),
            isNull(notifications.clearedAt),
            eq(notifications.targetType, 'conversation'),
            eq(notifications.targetId, conversationId),
            inArray(notifications.kind, ['reply', 'mention']),
            isNull(notifications.readAt),
            sql`coalesce((${notifications.payload}->>'seq')::int, 0) <= ${seq}`,
          ),
        )
        .returning({ id: notifications.id });
      announceRead(memberId, read);
    },

    /** Keep dedupe and delivery history while removing the pointer from lists and counts. */
    async clearRequest(requestId: string): Promise<void> {
      await getDb()
        .update(notifications)
        .set({ clearedAt: sql`now()`, readAt: sql`coalesce(${notifications.readAt}, now())` })
        .where(and(eq(notifications.requestId, requestId), isNull(notifications.clearedAt)));
    },

    /** Called with request announcements after the enclosing transaction commits. */
    announceRemoved(memberId: string, requestId: string) {
      deps.hub.publish([memberId], { type: 'notification.removed', data: { request_id: requestId } });
    },

    /** Pending totals support conversation/widget sync; the notification badge uses unread. */
    async summary(memberId: string): Promise<{ needs_you: number; unread: number }> {
      const [[pending], [unread]] = await Promise.all([
        getDb()
          .select({ n: count() })
          .from(requests)
          .where(and(eq(requests.memberId, memberId), eq(requests.status, 'pending'))),
        getDb()
          .select({ n: count() })
          .from(notifications)
          .where(
            and(eq(notifications.memberId, memberId), isNull(notifications.clearedAt), isNull(notifications.readAt)),
          ),
      ]);
      return { needs_you: pending?.n ?? 0, unread: unread?.n ?? 0 };
    },
  };
}

export type NotificationsService = ReturnType<typeof createNotificationsService>;
