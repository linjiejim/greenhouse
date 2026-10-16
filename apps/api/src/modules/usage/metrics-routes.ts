import { Hono } from 'hono';
import { adoptInputSchema, metricsQuerySchema } from '@greenhouse/contract';
import type { AppEnv } from '../../http/env.js';
import { readJson, readQuery } from '../../http/validate.js';
import type { MetricsService } from './metrics.js';
export function metricRoutes(service: MetricsService) {
  return new Hono<AppEnv>().post('/adopt', async (c) => {
    await service.adopt(c.get('member').id, await readJson(c, adoptInputSchema));
    return c.body(null, 204);
  });
}
export function adminMetricRoutes(service: MetricsService) {
  return new Hono<AppEnv>().get('/usage/metrics', async (c) =>
    c.json(await service.weekly(c.get('member').id, readQuery(c, metricsQuerySchema).weeks)),
  );
}
