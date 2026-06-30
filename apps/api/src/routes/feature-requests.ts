/**
 * Feature Request routes — /api/admin/feature-requests
 *
 * GET    /api/admin/feature-requests          — 列表（支持 status 过滤、分页）
 * PATCH  /api/admin/feature-requests/:id      — 更新状态/优先级/备注
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import type { FeatureRequestStatus } from '@greenhouse/db';
import type { AppEnv } from '../app-env.js';

const featureRequests = new Hono<AppEnv>()
  /** GET / — list feature requests */
  .get('/', async (c) => {
    const status = c.req.query('status') as FeatureRequestStatus | undefined;
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    const requests = await getDb().featureRequests.list({ status, limit, offset });
    const total = await getDb().featureRequests.count(status);

    // Enrich with user nicknames
    const users = await getDb().users.list();
    const userMap = new Map(users.map((u) => [u.id, u]));

    const enriched = requests.map((r) => ({
      ...r,
      submitted_by_nickname: userMap.get(r.submitted_by)?.nickname ?? r.submitted_by,
      submitted_by_role: userMap.get(r.submitted_by)?.role ?? 'unknown',
    }));

    return c.json({ total, requests: enriched });
  })
  /** PATCH /:id — update a feature request */
  .patch('/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

    const body = (await c.req.json()) as {
      status?: FeatureRequestStatus;
      priority?: 'low' | 'normal' | 'high';
      admin_note?: string;
    };

    const updated = await getDb().featureRequests.update(id, {
      status: body.status,
      priority: body.priority,
      admin_note: body.admin_note,
    });

    if (!updated) return c.json({ error: 'Feature request not found' }, 404);

    return c.json({ request: updated });
  });

export default featureRequests;
