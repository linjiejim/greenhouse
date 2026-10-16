/**
 * GET  /api/notifications?unread=           newest first
 * GET  /api/notifications/summary           the one badge: needs-you count, and unread
 * POST /api/notifications/read              mark some, or all, read
 */

import { Hono } from 'hono';
import { notificationListQuerySchema, readNotificationsInputSchema } from '@greenhouse/contract';
import type { AppEnv } from '../../http/env.js';
import { readJson, readQuery } from '../../http/validate.js';
import type { NotificationsService } from './service.js';

export function notificationRoutes(service: NotificationsService) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await service.list(c.get('member').id, readQuery(c, notificationListQuerySchema))))
    .get('/summary', async (c) => c.json(await service.summary(c.get('member').id)))
    .post('/read', async (c) => {
      await service.markRead(c.get('member').id, await readJson(c, readNotificationsInputSchema));
      return c.body(null, 204);
    });
}
