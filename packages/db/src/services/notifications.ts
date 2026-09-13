/**
 * Permanent platform notification and delivery-attempt service.
 *
 * In-app notification creation is idempotent per `(user_id, dedupe_key)`.
 * Read state is the only mutable user-facing field. Optional external
 * deliveries use SKIP LOCKED leases and never mutate the originating business
 * Run, Interrupt or Agent lifecycle row.
 */

import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { notificationDeliveryAttempts, notifications } from '../schema/index.js';
import type {
  NotificationDeliveryAttemptRow,
  NotificationDeliveryChannel,
  NotificationKind,
  NotificationRow,
} from '../schema/notification.js';

export class NotificationError extends Error {
  constructor(
    public readonly code:
      | 'notification_invalid_input'
      | 'notification_idempotency_conflict'
      | 'notification_lease_lost',
    message: string,
  ) {
    super(message);
    this.name = 'NotificationError';
  }
}

export interface CreateNotificationInput {
  id?: string;
  user_id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  payload?: unknown;
  run_id?: string | null;
  interrupt_id?: string | null;
  event_id?: string | null;
  agent_id?: string | null;
  dedupe_key: string;
  created_at?: string | Date;
}

export interface NotificationCursor {
  created_at: string;
  id: string;
}

export interface NotificationListResult {
  items: NotificationRow[];
  next_cursor: NotificationCursor | null;
}

export interface CreateNotificationDeliveryInput {
  id?: string;
  notification_id: string;
  channel: NotificationDeliveryChannel;
  recipient: string;
  available_at?: string | Date;
  max_attempts?: number;
}

function invalid(message: string): never {
  throw new NotificationError('notification_invalid_input', message);
}

function identifier(value: string, label: string, max = 512): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) invalid(`${label} must contain 1-${max} characters`);
  return normalized;
}

function positiveInt(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) invalid(`${label} must be a positive safe integer`);
  return value;
}

function timestamp(value: string | Date | undefined, label = 'timestamp'): string {
  if (value === undefined) return nowIso();
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) invalid(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

function json(value: unknown): string {
  try {
    const encoded = JSON.stringify(value ?? {});
    if (encoded === undefined) invalid('payload must be JSON serializable');
    return encoded;
  } catch (error) {
    if (error instanceof NotificationError) throw error;
    invalid('payload must be JSON serializable');
  }
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function sameInstant(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}

export function createNotificationService(db: Db) {
  const service = {
    async createWithStatus(
      input: CreateNotificationInput,
    ): Promise<{ notification: NotificationRow; created: boolean }> {
      const rowId = input.id ? identifier(input.id, 'id') : id('ntf');
      const userId = identifier(input.user_id, 'user_id');
      const dedupeKey = identifier(input.dedupe_key, 'dedupe_key');
      const title = identifier(input.title, 'title', 512);
      const body = input.body.trim();
      if (!body) invalid('body must not be empty');
      const payload = json(input.payload);
      const createdAt = timestamp(input.created_at, 'created_at');

      return db.transaction(async (tx) => {
        const lockKey = `notification:${userId}:${dedupeKey}`;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        const [existing] = await tx
          .select()
          .from(notifications)
          .where(and(eq(notifications.user_id, userId), eq(notifications.dedupe_key, dedupeKey)))
          .limit(1);
        if (existing) {
          const matches =
            (input.id === undefined || existing.id === rowId) &&
            existing.kind === input.kind &&
            existing.title === title &&
            existing.body === body &&
            existing.payload === payload &&
            existing.run_id === (input.run_id ?? null) &&
            existing.interrupt_id === (input.interrupt_id ?? null) &&
            existing.event_id === (input.event_id ?? null) &&
            existing.agent_id === (input.agent_id ?? null) &&
            (input.created_at === undefined || sameInstant(existing.created_at, createdAt));
          if (!matches) {
            throw new NotificationError(
              'notification_idempotency_conflict',
              'Notification dedupe key was reused with different content',
            );
          }
          return { notification: existing, created: false };
        }

        const [created] = await tx
          .insert(notifications)
          .values({
            id: rowId,
            user_id: userId,
            kind: input.kind,
            title,
            body,
            payload,
            run_id: input.run_id ?? null,
            interrupt_id: input.interrupt_id ?? null,
            event_id: input.event_id ?? null,
            agent_id: input.agent_id ?? null,
            dedupe_key: dedupeKey,
            created_at: createdAt,
          })
          .returning();
        return { notification: created!, created: true };
      });
    },

    async create(input: CreateNotificationInput): Promise<NotificationRow> {
      return (await service.createWithStatus(input)).notification;
    },

    /** Internal transport lookup. Delivery-attempt rows are never exposed by the user API. */
    async get(notificationId: string): Promise<NotificationRow | undefined> {
      const [row] = await db
        .select()
        .from(notifications)
        .where(eq(notifications.id, identifier(notificationId, 'notification_id')))
        .limit(1);
      return row;
    },

    async getForUser(notificationId: string, userId: string): Promise<NotificationRow | undefined> {
      const [row] = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.id, identifier(notificationId, 'notification_id')),
            eq(notifications.user_id, identifier(userId, 'user_id')),
          ),
        )
        .limit(1);
      return row;
    },

    async listForUser(input: {
      user_id: string;
      unread_only?: boolean;
      cursor?: NotificationCursor | null;
      limit?: number;
    }): Promise<NotificationListResult> {
      const userId = identifier(input.user_id, 'user_id');
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
      const cursor = input.cursor
        ? {
            created_at: timestamp(input.cursor.created_at, 'cursor.created_at'),
            id: identifier(input.cursor.id, 'cursor.id'),
          }
        : null;
      const rows = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.user_id, userId),
            ...(input.unread_only ? [isNull(notifications.read_at)] : []),
            ...(cursor
              ? [
                  or(
                    lt(notifications.created_at, cursor.created_at),
                    and(eq(notifications.created_at, cursor.created_at), lt(notifications.id, cursor.id)),
                  ),
                ]
              : []),
          ),
        )
        .orderBy(desc(notifications.created_at), desc(notifications.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const tail = items.at(-1);
      return {
        items,
        next_cursor:
          hasMore && tail
            ? {
                created_at: tail.created_at,
                id: tail.id,
              }
            : null,
      };
    },

    async countUnread(userId: string): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(eq(notifications.user_id, identifier(userId, 'user_id')), isNull(notifications.read_at)));
      return row?.count ?? 0;
    },

    async markRead(
      notificationId: string,
      userId: string,
      at: string | Date = new Date(),
    ): Promise<NotificationRow | undefined> {
      const rows = await db
        .update(notifications)
        .set({ read_at: timestamp(at, 'read_at') })
        .where(
          and(
            eq(notifications.id, identifier(notificationId, 'notification_id')),
            eq(notifications.user_id, identifier(userId, 'user_id')),
            isNull(notifications.read_at),
          ),
        )
        .returning();
      if (rows[0]) return rows[0];
      return service.getForUser(notificationId, userId);
    },

    async markAllRead(userId: string, at: string | Date = new Date()): Promise<number> {
      const rows = await db
        .update(notifications)
        .set({ read_at: timestamp(at, 'read_at') })
        .where(and(eq(notifications.user_id, identifier(userId, 'user_id')), isNull(notifications.read_at)))
        .returning({ id: notifications.id });
      return rows.length;
    },

    async createDelivery(input: CreateNotificationDeliveryInput): Promise<NotificationDeliveryAttemptRow> {
      const notificationId = identifier(input.notification_id, 'notification_id');
      const recipient = identifier(input.recipient, 'recipient', 2048);
      const rowId = input.id ? identifier(input.id, 'id') : id('nda');
      const availableAt = timestamp(input.available_at, 'available_at');
      const maxAttempts = positiveInt(input.max_attempts ?? 5, 'max_attempts');
      return db.transaction(async (tx) => {
        const lockKey = `notification-delivery:${notificationId}:${input.channel}:${recipient}`;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        const [existing] = await tx
          .select()
          .from(notificationDeliveryAttempts)
          .where(
            and(
              eq(notificationDeliveryAttempts.notification_id, notificationId),
              eq(notificationDeliveryAttempts.channel, input.channel),
              eq(notificationDeliveryAttempts.recipient, recipient),
            ),
          )
          .limit(1);
        if (existing) {
          if (
            (input.id !== undefined && existing.id !== rowId) ||
            existing.max_attempts !== maxAttempts ||
            (input.available_at !== undefined && !sameInstant(existing.available_at, availableAt))
          ) {
            throw new NotificationError(
              'notification_idempotency_conflict',
              'Notification delivery identity was reused with different options',
            );
          }
          return existing;
        }
        const at = nowIso();
        const [created] = await tx
          .insert(notificationDeliveryAttempts)
          .values({
            id: rowId,
            notification_id: notificationId,
            channel: input.channel,
            recipient,
            max_attempts: maxAttempts,
            available_at: availableAt,
            created_at: at,
            updated_at: at,
          })
          .returning();
        return created!;
      });
    },

    async claimDeliveries(input: {
      worker_id: string;
      lease_ms: number;
      channels?: readonly NotificationDeliveryChannel[];
      limit?: number;
      at?: string | Date;
    }): Promise<NotificationDeliveryAttemptRow[]> {
      const workerId = identifier(input.worker_id, 'worker_id');
      const at = timestamp(input.at);
      const leaseMs = positiveInt(input.lease_ms, 'lease_ms');
      const leaseExpiresAt = new Date(Date.parse(at) + leaseMs).toISOString();
      const channels = input.channels ? [...new Set(input.channels)] : null;
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
      return db.transaction(async (tx) => {
        await tx
          .update(notificationDeliveryAttempts)
          .set({
            status: 'dead_letter',
            lease_owner: null,
            lease_expires_at: null,
            last_error: 'delivery lease expired after final attempt',
            updated_at: at,
            version: sql`${notificationDeliveryAttempts.version} + 1`,
          })
          .where(
            and(
              eq(notificationDeliveryAttempts.status, 'claimed'),
              lte(notificationDeliveryAttempts.lease_expires_at, at),
              sql`${notificationDeliveryAttempts.attempts} >= ${notificationDeliveryAttempts.max_attempts}`,
            ),
          );
        await tx
          .update(notificationDeliveryAttempts)
          .set({
            status: 'pending',
            lease_owner: null,
            lease_expires_at: null,
            last_error: 'delivery lease expired',
            updated_at: at,
            version: sql`${notificationDeliveryAttempts.version} + 1`,
          })
          .where(
            and(
              eq(notificationDeliveryAttempts.status, 'claimed'),
              lte(notificationDeliveryAttempts.lease_expires_at, at),
              sql`${notificationDeliveryAttempts.attempts} < ${notificationDeliveryAttempts.max_attempts}`,
            ),
          );
        const candidates = await tx
          .select()
          .from(notificationDeliveryAttempts)
          .where(
            and(
              eq(notificationDeliveryAttempts.status, 'pending'),
              lte(notificationDeliveryAttempts.available_at, at),
              ...(channels?.length ? [inArray(notificationDeliveryAttempts.channel, channels)] : []),
            ),
          )
          .orderBy(
            asc(notificationDeliveryAttempts.available_at),
            asc(notificationDeliveryAttempts.created_at),
            asc(notificationDeliveryAttempts.id),
          )
          .limit(limit)
          .for('update', { skipLocked: true });
        if (candidates.length === 0) return [];
        return tx
          .update(notificationDeliveryAttempts)
          .set({
            status: 'claimed',
            attempts: sql`${notificationDeliveryAttempts.attempts} + 1`,
            lease_owner: workerId,
            lease_expires_at: leaseExpiresAt,
            updated_at: at,
            version: sql`${notificationDeliveryAttempts.version} + 1`,
          })
          .where(
            and(
              inArray(
                notificationDeliveryAttempts.id,
                candidates.map((row) => row.id),
              ),
              eq(notificationDeliveryAttempts.status, 'pending'),
            ),
          )
          .returning();
      });
    },

    async acknowledgeDelivery(input: {
      id: string;
      expected_version: number;
      worker_id: string;
      at?: string | Date;
    }): Promise<NotificationDeliveryAttemptRow> {
      const at = timestamp(input.at);
      const [updated] = await db
        .update(notificationDeliveryAttempts)
        .set({
          status: 'delivered',
          lease_owner: null,
          lease_expires_at: null,
          last_error: null,
          delivered_at: at,
          updated_at: at,
          version: sql`${notificationDeliveryAttempts.version} + 1`,
        })
        .where(
          and(
            eq(notificationDeliveryAttempts.id, identifier(input.id, 'id')),
            eq(notificationDeliveryAttempts.version, positiveInt(input.expected_version, 'expected_version')),
            eq(notificationDeliveryAttempts.status, 'claimed'),
            eq(notificationDeliveryAttempts.lease_owner, identifier(input.worker_id, 'worker_id')),
            gt(notificationDeliveryAttempts.lease_expires_at, at),
          ),
        )
        .returning();
      if (!updated) {
        throw new NotificationError('notification_lease_lost', 'Notification delivery lease is no longer owned');
      }
      return updated;
    },

    async failDelivery(input: {
      id: string;
      expected_version: number;
      worker_id: string;
      error: string;
      retry_at?: string | Date;
      at?: string | Date;
    }): Promise<NotificationDeliveryAttemptRow> {
      const at = timestamp(input.at);
      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(notificationDeliveryAttempts)
          .where(eq(notificationDeliveryAttempts.id, identifier(input.id, 'id')))
          .for('update');
        if (
          !locked ||
          locked.version !== positiveInt(input.expected_version, 'expected_version') ||
          locked.status !== 'claimed' ||
          locked.lease_owner !== identifier(input.worker_id, 'worker_id') ||
          !locked.lease_expires_at ||
          Date.parse(locked.lease_expires_at) <= Date.parse(at)
        ) {
          throw new NotificationError('notification_lease_lost', 'Notification delivery lease is no longer owned');
        }
        const terminal = locked.attempts >= locked.max_attempts;
        const [updated] = await tx
          .update(notificationDeliveryAttempts)
          .set({
            status: terminal ? 'dead_letter' : 'pending',
            available_at: terminal
              ? locked.available_at
              : timestamp(input.retry_at ?? new Date(Date.parse(at) + 60_000), 'retry_at'),
            lease_owner: null,
            lease_expires_at: null,
            last_error: input.error,
            updated_at: at,
            version: sql`${notificationDeliveryAttempts.version} + 1`,
          })
          .where(
            and(
              eq(notificationDeliveryAttempts.id, locked.id),
              eq(notificationDeliveryAttempts.version, locked.version),
            ),
          )
          .returning();
        return updated!;
      });
    },
  };
  return service;
}

export type NotificationService = ReturnType<typeof createNotificationService>;
