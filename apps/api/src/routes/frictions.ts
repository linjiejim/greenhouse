/**
 * Tool Friction routes — /api/admin/frictions
 *
 * GET    /api/admin/frictions        — 复盘队列（按频次排序，可按状态/工具过滤）
 * PATCH  /api/admin/frictions/:id    — 流转状态、写解决备注
 * DELETE /api/admin/frictions/:id    — 删除一条（误报清理）
 * POST   /api/admin/frictions/mine   — 立即跑一次挖掘（等不到凌晨那次）
 *
 * super only（挂载点已包在 requireSuper 下）。这是给人看的队列，
 * 修复动作发生在 harness 层，本路由不产生任何对 Agent 的注入。
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import type { ToolFrictionStatus } from '@greenhouse/db';
import { mineToolErrors } from '../frictions/friction-center.js';
import type { AppEnv } from '../app-env.js';

const VALID_STATUSES: ToolFrictionStatus[] = ['new', 'acknowledged', 'resolved', 'archived'];

const frictions = new Hono<AppEnv>()
  /** GET / — review queue */
  .get('/', async (c) => {
    const statusParam = c.req.query('status');
    const status =
      statusParam && VALID_STATUSES.includes(statusParam as ToolFrictionStatus)
        ? (statusParam as ToolFrictionStatus)
        : undefined;
    const toolId = c.req.query('tool_id') || undefined;
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    const items = await getDb().toolFrictions.list({ status, tool_id: toolId, limit, offset });
    const total = await getDb().toolFrictions.count({ status, tool_id: toolId });

    return c.json({ total, frictions: items });
  })
  /** PATCH /:id — move status / record how it was fixed */
  .patch('/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

    const body = (await c.req.json()) as { status?: string; resolution_note?: string | null };
    if (body.status !== undefined && !VALID_STATUSES.includes(body.status as ToolFrictionStatus)) {
      return c.json({ error: 'Invalid status' }, 400);
    }
    if (body.status === undefined && body.resolution_note === undefined) {
      return c.json({ error: 'Nothing to update' }, 400);
    }

    const updated = await getDb().toolFrictions.update(id, {
      status: body.status as ToolFrictionStatus | undefined,
      resolution_note: body.resolution_note,
    });
    if (!updated) return c.json({ error: 'Friction not found' }, 404);

    return c.json(updated);
  })
  /** DELETE /:id — drop a false positive outright */
  .delete('/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

    const deleted = await getDb().toolFrictions.delete(id);
    if (!deleted) return c.json({ error: 'Friction not found' }, 404);

    return c.json({ deleted: true });
  })
  /** POST /mine — run the miner now instead of waiting for the 04:00 sweep */
  .post('/mine', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { window_hours?: number };
    const windowHours = Math.min(Math.max(body.window_hours ?? 25, 1), 24 * 30);

    const result = await mineToolErrors(getDb(), { windowHours });
    return c.json(result);
  });

export default frictions;
