import { Hono } from 'hono';
import type { AppEnv } from '../../http/env.js';
import { readJson } from '../../http/validate.js';
import { saveMediaInput, type MediaService } from './service.js';

export function mediaRoutes(service: MediaService) {
  return new Hono<AppEnv>().post('/files/:id/save', async (c) =>
    c.json(await service.save(c.get('member').id, c.req.param('id'), await readJson(c, saveMediaInput)), 201),
  );
}
