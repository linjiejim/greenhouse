/** Internal platform notification center routes — `/api/notifications`. */

import { Hono } from 'hono';
import { getDb, type NotificationRow } from '@greenhouse/db';
import type {
  PlatformNotification,
  PlatformNotificationList,
  PlatformNotificationSummary,
} from '@greenhouse/types/notification';
import type { RuntimeJsonValue } from '@greenhouse/types/runtime';
import { safeJsonParse } from '@greenhouse/utils/json';

import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { connectionManager } from '../ws/connection-manager.js';

interface CursorValue {
  created_at: string;
  id: string;
}

function encodeCursor(value: CursorValue | null): string | null {
  return value ? Buffer.from(JSON.stringify(value), 'utf8').toString('base64url') : null;
}

function decodeCursor(value: string | undefined): CursorValue | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<CursorValue>;
    if (typeof parsed.created_at !== 'string' || !Number.isFinite(Date.parse(parsed.created_at))) throw new Error();
    if (typeof parsed.id !== 'string' || !parsed.id.trim()) throw new Error();
    return { created_at: new Date(parsed.created_at).toISOString(), id: parsed.id };
  } catch {
    throw new Error('invalid_cursor');
  }
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) throw new Error('invalid_limit');
  return parsed;
}

function toWire(row: NotificationRow): PlatformNotification {
  return {
    id: row.id,
    user_id: row.user_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    payload: safeJsonParse(row.payload, {}) as RuntimeJsonValue,
    run_id: row.run_id,
    interrupt_id: row.interrupt_id,
    event_id: row.event_id,
    agent_id: row.agent_id,
    read_at: row.read_at ? new Date(row.read_at).toISOString() : null,
    created_at: new Date(row.created_at).toISOString(),
  };
}

async function pushSummary(userId: string): Promise<void> {
  const unread = await getDb().notifications.countUnread(userId);
  connectionManager.sendToUser(userId, { type: 'notification:summary', unread });
}

export function createNotificationRoutes() {
  return new Hono<AppEnv>()
    .get('/', async (c) => {
      const actor = getAuthUser(c);
      let cursor: CursorValue | null;
      let limit: number;
      try {
        cursor = decodeCursor(c.req.query('cursor'));
        limit = parseLimit(c.req.query('limit'));
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'invalid_query' }, 400);
      }
      const result = await getDb().notifications.listForUser({
        user_id: actor.id,
        unread_only: c.req.query('unread_only') === '1' || c.req.query('unread_only') === 'true',
        cursor,
        limit,
      });
      return c.json({
        notifications: result.items.map(toWire),
        next_cursor: encodeCursor(result.next_cursor),
      } satisfies PlatformNotificationList);
    })
    .get('/summary', async (c) => {
      const actor = getAuthUser(c);
      return c.json({
        unread: await getDb().notifications.countUnread(actor.id),
      } satisfies PlatformNotificationSummary);
    })
    .post('/:id/read', async (c) => {
      const actor = getAuthUser(c);
      const notification = await getDb().notifications.markRead(c.req.param('id'), actor.id);
      if (!notification) return c.json({ error: 'Notification not found' }, 404);
      await pushSummary(actor.id);
      return c.json({ notification: toWire(notification) });
    })
    .post('/read-all', async (c) => {
      const actor = getAuthUser(c);
      const marked = await getDb().notifications.markAllRead(actor.id);
      await pushSummary(actor.id);
      return c.json({ marked });
    });
}
