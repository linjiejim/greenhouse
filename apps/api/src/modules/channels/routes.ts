/**
 * GET    /api/me/notification-settings          my channels per category and previews; only channels I can use
 * PUT    /api/me/notification-settings          change some of it; fields left out keep their value
 * GET    /api/me/push-devices                   my phones, and whether this deployment pushes at all
 * PUT    /api/me/push-devices                   register or refresh this phone by its Expo token (nothing stored when pushes are off)
 * PATCH  /api/me/push-devices/:id               change this phone's switches
 * DELETE /api/me/push-devices/:id               unregister it: disabled, never deleted
 * POST   /api/me/push-devices/:id/test          one test push now (one per phone every 10 seconds)
 * GET    /api/admin/channels                    Feishu, WeCom, push: set up?, settings, last success and error
 * PUT    /api/admin/channels/:channel           save one channel's settings; secrets are write-only
 * POST   /api/admin/channels/:channel/test      a test message to me
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  ADMIN_CHANNELS,
  channelInputSchemas,
  idParamSchema,
  registerPushDeviceInputSchema,
  updateNotificationSettingsInputSchema,
  updatePushDeviceInputSchema,
} from '@greenhouse/contract';
import type { AppEnv } from '../../http/env.js';
import { readJson, readParam } from '../../http/validate.js';
import type { ChannelsService } from './service.js';

const channelParamSchema = z.enum(ADMIN_CHANNELS);

export function notificationSettingsRoutes(service: ChannelsService) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await service.settings(c.get('member').id)))
    .put('/', async (c) =>
      c.json(await service.saveSettings(c.get('member').id, await readJson(c, updateNotificationSettingsInputSchema))),
    );
}

export function pushDeviceRoutes(service: ChannelsService) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await service.devices(c.get('member').id)))
    .put('/', async (c) =>
      c.json(await service.registerDevice(c.get('member').id, await readJson(c, registerPushDeviceInputSchema))),
    )
    .patch('/:id', async (c) =>
      c.json(
        await service.updateDevice(
          c.get('member').id,
          readParam(c, 'id', idParamSchema),
          await readJson(c, updatePushDeviceInputSchema),
        ),
      ),
    )
    .delete('/:id', async (c) =>
      c.json(await service.unregisterDevice(c.get('member').id, readParam(c, 'id', idParamSchema))),
    )
    .post('/:id/test', async (c) =>
      c.json(await service.testDevice(c.get('member').id, readParam(c, 'id', idParamSchema))),
    );
}

export function adminChannelRoutes(service: ChannelsService) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await service.list()))
    .put('/:channel', async (c) => {
      const channel = readParam(c, 'channel', channelParamSchema);
      return c.json(await service.save(c.get('member').id, channel, await readJson(c, channelInputSchemas[channel])));
    })
    .post('/:channel/test', async (c) =>
      c.json(await service.test(c.get('member').id, readParam(c, 'channel', channelParamSchema))),
    );
}
