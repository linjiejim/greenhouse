/**
 * Session Group routes — /api/session-groups
 *
 * Per-user, folder-like organization of sessions (plus the built-in Pinned
 * group). Group CRUD is owner-scoped to the current user. Per-session
 * membership (file into a folder / pin) lives on the /api/sessions routes,
 * gated by canAccessSession so shared sessions can be organized too.
 *
 * GET    /api/session-groups                       — 当前用户的所有分组（含 Pinned）
 * POST   /api/session-groups                       — 创建自定义分组
 * POST   /api/session-groups/reorder               — 批量更新分组区块排序
 * POST   /api/session-groups/:gid/members/reorder  — 区块内会话拖拽排序
 * PATCH  /api/session-groups/:id                   — 更新分组（名称/颜色/图标/排序）
 * DELETE /api/session-groups/:id                   — 删除自定义分组（成员级联）
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import { getAuthUser } from '../auth/middleware.js';
import type { AppEnv } from '../app-env.js';

const MAX_GROUPS_PER_USER = 30;
const PINNED_KIND = 'pinned';

const sessionGroupRoutes = new Hono<AppEnv>()
  /** GET /api/session-groups — list groups (incl. Pinned) with member counts */
  .get('/', async (c) => {
    const user = getAuthUser(c);
    const [groups, counts] = await Promise.all([
      getDb().sessionGroups.listByUser(user.id),
      getDb().sessionGroups.getMemberCounts(user.id),
    ]);
    return c.json({ groups: groups.map((g) => ({ ...g, member_count: counts.get(g.id) ?? 0 })) });
  })
  /** POST /api/session-groups — create a custom folder */
  .post('/', async (c) => {
    const user = getAuthUser(c);
    const body = (await c.req.json()) as { name?: string; color?: string; icon?: string };

    if (!body.name?.trim()) {
      return c.json({ error: 'Group name is required' }, 400);
    }

    const existing = await getDb().sessionGroups.listByUser(user.id);
    const customCount = existing.filter((g) => g.kind !== PINNED_KIND).length;
    if (customCount >= MAX_GROUPS_PER_USER) {
      return c.json({ error: `Maximum ${MAX_GROUPS_PER_USER} groups allowed` }, 400);
    }

    try {
      const group = await getDb().sessionGroups.create({
        user_id: user.id,
        name: body.name.trim(),
        color: body.color,
        icon: body.icon,
        sort_order: customCount, // append after existing folders
      });
      return c.json(group, 201);
    } catch (err: any) {
      // drizzle wraps the PG error: the 23505 code lives on err.cause.
      const code = err?.code ?? err?.cause?.code;
      if (code === '23505' || err?.cause?.message?.includes('unique') || err?.message?.includes('unique')) {
        return c.json({ error: 'Group name already exists' }, 409);
      }
      throw err;
    }
  })
  /** POST /api/session-groups/reorder — batch update section order */
  .post('/reorder', async (c) => {
    const user = getAuthUser(c);
    const body = (await c.req.json()) as { updates: Array<{ id: number; sort_order: number }> };

    if (!Array.isArray(body.updates) || body.updates.length === 0) {
      return c.json({ error: 'Updates array required' }, 400);
    }

    const userGroups = await getDb().sessionGroups.listByUser(user.id);
    const userGroupIds = new Set(userGroups.map((g) => g.id));
    if (body.updates.some((u) => !userGroupIds.has(u.id))) {
      return c.json({ error: 'Some groups not found' }, 404);
    }

    await getDb().sessionGroups.reorder(body.updates);
    return c.json({ ok: true });
  })
  /** POST /api/session-groups/:gid/members/reorder — reorder sessions within a group */
  .post('/:gid/members/reorder', async (c) => {
    const user = getAuthUser(c);
    const gid = parseInt(c.req.param('gid'), 10);
    if (isNaN(gid)) return c.json({ error: 'Invalid group ID' }, 400);

    const group = await getDb().sessionGroups.getById(gid);
    if (!group || group.user_id !== user.id) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const body = (await c.req.json()) as { updates: Array<{ session_id: string; sort_order: number }> };
    if (!Array.isArray(body.updates) || body.updates.length === 0) {
      return c.json({ error: 'Updates array required' }, 400);
    }

    await getDb().sessionGroups.reorderMembers(user.id, gid, body.updates);
    return c.json({ ok: true });
  })
  /** PATCH /api/session-groups/:id — update a folder (Pinned is immutable) */
  .patch('/:id', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid group ID' }, 400);

    const existing = await getDb().sessionGroups.getById(id);
    if (!existing || existing.user_id !== user.id) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (existing.kind === PINNED_KIND) {
      return c.json({ error: 'The Pinned group cannot be edited' }, 400);
    }

    const body = (await c.req.json()) as { name?: string; color?: string; icon?: string; sort_order?: number };
    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.color !== undefined) updates.color = body.color;
    if (body.icon !== undefined) updates.icon = body.icon;
    if (body.sort_order !== undefined) updates.sort_order = body.sort_order;

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    try {
      const group = await getDb().sessionGroups.update(id, updates);
      if (!group) return c.json({ error: 'Group not found' }, 404);
      return c.json(group);
    } catch (err: any) {
      // drizzle wraps the PG error: the 23505 code lives on err.cause.
      const code = err?.code ?? err?.cause?.code;
      if (code === '23505' || err?.cause?.message?.includes('unique') || err?.message?.includes('unique')) {
        return c.json({ error: 'Group name already exists' }, 409);
      }
      throw err;
    }
  })
  /** DELETE /api/session-groups/:id — delete a folder (Pinned cannot be deleted) */
  .delete('/:id', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid group ID' }, 400);

    const existing = await getDb().sessionGroups.getById(id);
    if (!existing || existing.user_id !== user.id) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (existing.kind === PINNED_KIND) {
      return c.json({ error: 'The Pinned group cannot be deleted' }, 400);
    }

    await getDb().sessionGroups.delete(id);
    return c.json({ ok: true });
  });

export default sessionGroupRoutes;
