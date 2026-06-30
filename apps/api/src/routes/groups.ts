/**
 * Group routes — /api/groups (internal users)
 *
 * GET    /api/groups                      — 我创建或所属的小组（super 看全部）
 * POST   /api/groups                      — 创建小组（可带初始成员）
 * GET    /api/groups/:id                  — 小组详情 + 成员（owner/成员/super）
 * PATCH  /api/groups/:id                  — 重命名/改描述（owner/super）
 * DELETE /api/groups/:id                  — 删除（owner/super）
 * POST   /api/groups/:id/members          — 添加成员（owner/super）
 * DELETE /api/groups/:id/members/:userId  — 移除成员（owner/super）
 *
 * 小组用作知识库精细共享的目标（knowledge_base_shares.shared_with='group:<id>'）。
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import type { UserGroupRow } from '@greenhouse/db';
import { getAuthUser } from '../auth/middleware.js';
import type { AppEnv } from '../app-env.js';

function groupToApi(g: UserGroupRow, memberCount?: number) {
  return {
    id: g.id,
    name: g.name,
    description: g.description || '',
    created_by: g.created_by,
    member_count: memberCount,
    created_at: g.created_at,
    updated_at: g.updated_at,
  };
}

function canManage(group: UserGroupRow, userId: string, role: string): boolean {
  return group.created_by === userId || role === 'super';
}

const groupRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const user = getAuthUser(c);
    const groups = user.role === 'super' ? await getDb().groups.listAll() : await getDb().groups.listForUser(user.id);
    const withCounts = await Promise.all(
      groups.map(async (g) => groupToApi(g, (await getDb().groups.listMembers(g.id)).length)),
    );
    return c.json({ groups: withCounts });
  })
  .post('/', async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    if (!name) return c.json({ error: 'name is required' }, 400);

    const group = await getDb().groups.create({
      name,
      description: typeof body.description === 'string' ? body.description : null,
      created_by: user.id,
    });
    const memberIds: string[] = Array.isArray(body.member_ids) ? body.member_ids.map(String) : [];
    if (memberIds.length > 0) await getDb().groups.addMembers(group.id, memberIds, user.id);
    return c.json({ group: groupToApi(group, memberIds.length) }, 201);
  })
  .get('/:id', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
    const group = await getDb().groups.getById(id);
    if (!group) return c.json({ error: 'Group not found' }, 404);

    const members = await getDb().groups.listMembers(id);
    const isMember = members.some((m) => m.user_id === user.id);
    if (group.created_by !== user.id && !isMember && user.role !== 'super') {
      return c.json({ error: 'Group not found' }, 404);
    }
    const enriched = await Promise.all(
      members.map(async (m) => {
        const u = await getDb().users.getById(m.user_id);
        return { user_id: m.user_id, nickname: u?.nickname || 'Unknown', email: u?.email, added_at: m.created_at };
      }),
    );
    return c.json({ group: groupToApi(group, members.length), members: enriched });
  })
  .patch('/:id', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
    const group = await getDb().groups.getById(id);
    if (!group) return c.json({ error: 'Group not found' }, 404);
    if (!canManage(group, user.id, user.role)) return c.json({ error: 'Only the group owner can manage it' }, 403);

    const body = await c.req.json().catch(() => ({}));
    const updates: { name?: string; description?: string | null } = {};
    if (typeof body.name === 'string' && body.name.trim()) updates.name = body.name.trim();
    if (body.description !== undefined)
      updates.description = body.description === null ? null : String(body.description);
    const updated = await getDb().groups.update(id, updates);
    return c.json({ group: updated ? groupToApi(updated) : null });
  })
  .delete('/:id', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
    const group = await getDb().groups.getById(id);
    if (!group) return c.json({ error: 'Group not found' }, 404);
    if (!canManage(group, user.id, user.role)) return c.json({ error: 'Only the group owner can delete it' }, 403);
    await getDb().groups.delete(id);
    return c.json({ success: true });
  })
  .post('/:id/members', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
    const group = await getDb().groups.getById(id);
    if (!group) return c.json({ error: 'Group not found' }, 404);
    if (!canManage(group, user.id, user.role)) return c.json({ error: 'Only the group owner can manage members' }, 403);

    const body = await c.req.json().catch(() => ({}));
    const userIds: string[] = Array.isArray(body.user_ids) ? body.user_ids.map(String) : [];
    if (userIds.length === 0) return c.json({ error: 'user_ids required' }, 400);
    await getDb().groups.addMembers(id, userIds, user.id);
    return c.json({ success: true });
  })
  .delete('/:id/members/:userId', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
    const group = await getDb().groups.getById(id);
    if (!group) return c.json({ error: 'Group not found' }, 404);
    if (!canManage(group, user.id, user.role)) return c.json({ error: 'Only the group owner can manage members' }, 403);
    const ok = await getDb().groups.removeMember(id, c.req.param('userId'));
    if (!ok) return c.json({ error: 'Member not found' }, 404);
    return c.json({ success: true });
  });

export default groupRoutes;
