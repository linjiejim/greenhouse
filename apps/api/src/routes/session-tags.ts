/**
 * Session Tag routes — /api/session-tags
 *
 * GET    /api/session-tags              — 获取当前用户的所有标签
 * POST   /api/session-tags              — 创建新标签
 * PATCH  /api/session-tags/:id          — 更新标签（名称/颜色/排序）
 * DELETE /api/session-tags/:id          — 删除标签
 * POST   /api/session-tags/reorder      — 批量更新排序
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import { getAuthUser } from '../auth/middleware.js';
import type { AppEnv } from '../app-env.js';

const MAX_TAGS_PER_USER = 20;

const sessionTagRoutes = new Hono<AppEnv>()
  /** GET /api/session-tags — list all tags for current user */
  .get('/', async (c) => {
    const user = getAuthUser(c);
    const tags = await getDb().sessionTags.listByUser(user.id);
    return c.json({ tags });
  })
  /** POST /api/session-tags — create a new tag */
  .post('/', async (c) => {
    const user = getAuthUser(c);
    const body = (await c.req.json()) as { name?: string; color?: string };

    if (!body.name?.trim()) {
      return c.json({ error: 'Tag name is required' }, 400);
    }

    // Check limit
    const existing = await getDb().sessionTags.listByUser(user.id);
    if (existing.length >= MAX_TAGS_PER_USER) {
      return c.json({ error: `Maximum ${MAX_TAGS_PER_USER} tags allowed` }, 400);
    }

    try {
      const tag = await getDb().sessionTags.create({
        user_id: user.id,
        name: body.name.trim(),
        color: body.color,
        sort_order: existing.length,
      });
      return c.json(tag, 201);
    } catch (err: any) {
      // drizzle wraps the PG error: the 23505 code lives on err.cause.
      const code = err?.code ?? err?.cause?.code;
      if (code === '23505' || err?.cause?.message?.includes('unique') || err?.message?.includes('unique')) {
        return c.json({ error: 'Tag name already exists' }, 409);
      }
      throw err;
    }
  })
  /** POST /api/session-tags/reorder — batch update sort_order */
  .post('/reorder', async (c) => {
    const user = getAuthUser(c);
    const body = (await c.req.json()) as { updates: Array<{ id: number; sort_order: number }> };

    if (!Array.isArray(body.updates) || body.updates.length === 0) {
      return c.json({ error: 'Updates array required' }, 400);
    }

    // Verify all tags belong to user
    const userTags = await getDb().sessionTags.listByUser(user.id);
    const userTagIds = new Set(userTags.map((t) => t.id));
    const invalid = body.updates.some((u) => !userTagIds.has(u.id));
    if (invalid) {
      return c.json({ error: 'Some tags not found' }, 404);
    }

    await getDb().sessionTags.reorder(body.updates);
    return c.json({ ok: true });
  })
  /** PATCH /api/session-tags/:id — update a tag */
  .patch('/:id', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid tag ID' }, 400);

    // Check ownership
    const existing = await getDb().sessionTags.getById(id);
    if (!existing || existing.user_id !== user.id) {
      return c.json({ error: 'Tag not found' }, 404);
    }

    const body = (await c.req.json()) as { name?: string; color?: string; sort_order?: number };
    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.color !== undefined) updates.color = body.color;
    if (body.sort_order !== undefined) updates.sort_order = body.sort_order;

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    try {
      const tag = await getDb().sessionTags.update(id, updates);
      if (!tag) return c.json({ error: 'Tag not found' }, 404);
      return c.json(tag);
    } catch (err: any) {
      // drizzle wraps the PG error: the 23505 code lives on err.cause.
      const code = err?.code ?? err?.cause?.code;
      if (code === '23505' || err?.cause?.message?.includes('unique') || err?.message?.includes('unique')) {
        return c.json({ error: 'Tag name already exists' }, 409);
      }
      throw err;
    }
  })
  /** DELETE /api/session-tags/:id — delete a tag */
  .delete('/:id', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid tag ID' }, 400);

    // Check ownership
    const existing = await getDb().sessionTags.getById(id);
    if (!existing || existing.user_id !== user.id) {
      return c.json({ error: 'Tag not found' }, 404);
    }

    await getDb().sessionTags.delete(id);
    return c.json({ ok: true });
  });

export default sessionTagRoutes;
