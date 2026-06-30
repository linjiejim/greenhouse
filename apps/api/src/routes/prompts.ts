/**
 * Prompt routes — /api/prompts
 *
 * GET    /api/prompts          — 获取当前用户可用的指令列表（个人 + 全局）
 * POST   /api/prompts          — 创建快捷指令
 * PATCH  /api/prompts/:id      — 更新快捷指令
 * DELETE /api/prompts/:id      — 删除快捷指令
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import { getAuthUser } from '../auth/middleware.js';
import type { AppEnv } from '../app-env.js';

const prompts = new Hono<AppEnv>()
  /** GET /api/prompts — list available prompts for current user */
  .get('/', async (c) => {
    const user = getAuthUser(c);
    if (user.role === 'external') return c.json({ error: 'Forbidden' }, 403);

    const list = await getDb().userPrompts.listForUser(user.id);
    return c.json({ prompts: list });
  })
  /** POST /api/prompts — create a new prompt */
  .post('/', async (c) => {
    const user = getAuthUser(c);
    if (user.role === 'external') return c.json({ error: 'Forbidden' }, 403);

    const body = (await c.req.json()) as {
      title?: string;
      content?: string;
      shortcut?: string;
      sort_order?: number;
      is_global?: boolean;
    };

    if (!body.title?.trim() || !body.content?.trim()) {
      return c.json({ error: 'title and content are required' }, 400);
    }

    // Only super can create global prompts
    if (body.is_global && user.role !== 'super') {
      return c.json({ error: 'Only super users can create global prompts' }, 403);
    }

    const prompt = await getDb().userPrompts.create({
      user_id: user.id,
      title: body.title.trim(),
      content: body.content.trim(),
      shortcut: body.shortcut?.trim() || undefined,
      sort_order: body.sort_order,
      is_global: body.is_global,
    });

    return c.json(prompt, 201);
  })
  /** PATCH /api/prompts/:id — update a prompt */
  .patch('/:id', async (c) => {
    const user = getAuthUser(c);
    if (user.role === 'external') return c.json({ error: 'Forbidden' }, 403);

    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const existing = await getDb().userPrompts.getById(id);
    if (!existing) return c.json({ error: 'Prompt not found' }, 404);

    // Owner can edit own; super can edit any (including global)
    if (existing.user_id !== user.id && user.role !== 'super') {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const body = (await c.req.json()) as {
      title?: string;
      content?: string;
      shortcut?: string | null;
      sort_order?: number;
      is_global?: boolean;
    };

    // Only super can set is_global
    if (body.is_global !== undefined && user.role !== 'super') {
      return c.json({ error: 'Only super users can set global flag' }, 403);
    }

    const updates: Record<string, unknown> = {};
    if (body.title !== undefined) updates.title = body.title.trim();
    if (body.content !== undefined) updates.content = body.content.trim();
    if (body.shortcut !== undefined) updates.shortcut = body.shortcut?.trim() || null;
    if (body.sort_order !== undefined) updates.sort_order = body.sort_order;
    if (body.is_global !== undefined) updates.is_global = body.is_global;

    const updated = await getDb().userPrompts.update(id, updates);
    if (!updated) return c.json({ error: 'Prompt not found' }, 404);
    return c.json(updated);
  })
  /** DELETE /api/prompts/:id — delete a prompt */
  .delete('/:id', async (c) => {
    const user = getAuthUser(c);
    if (user.role === 'external') return c.json({ error: 'Forbidden' }, 403);

    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const existing = await getDb().userPrompts.getById(id);
    if (!existing) return c.json({ error: 'Prompt not found' }, 404);

    // Owner can delete own; super can delete any
    if (existing.user_id !== user.id && user.role !== 'super') {
      return c.json({ error: 'Forbidden' }, 403);
    }

    await getDb().userPrompts.delete(id);
    return c.json({ ok: true });
  });

export default prompts;
