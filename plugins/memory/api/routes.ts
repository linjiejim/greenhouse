/** Personal memory routes — /api/auth/me/memories (GET, PATCH, DELETE). */
import { Hono } from 'hono';
import { getAuthUser, getDb, userHasFeature, toRowId, type AppEnv } from '@greenhouse/api/extension-kit';
import type { UserMemoryCategory, UserMemoryStatus } from './schema.js';
import { validateMemoryText } from './llm/memory-limits.js';
import { memoryServices } from './services.js';
export const memoryRoutes = new Hono<AppEnv>()
  // ─── User Memories (self-service) ─────────────────
  // All three writes share one gate and one validator with the `memory` tool:
  // v1 gated only the GET, and gated it against the raw table so super users —
  // who are enabled by role, not by row — got a 403 on their own memories.

  /** GET /api/auth/me/memories — list the caller's memories (any status) */
  .get('/', async (c) => {
    const authUser = getAuthUser(c);
    if (!authUser) return c.json({ error: 'Not authenticated' }, 401);
    if (!(await userHasFeature(authUser.id, authUser.role, 'memory'))) {
      return c.json({ error: 'Memory feature not enabled for your account' }, 403);
    }

    const memories = await memoryServices(getDb()).userMemories.listByUser(authUser.id);
    return c.json({ memories });
  })
  /** PATCH /api/auth/me/memories/:id — edit content/category/pinned, or move status */
  .patch('/:id', async (c) => {
    const authUser = getAuthUser(c);
    if (!authUser) return c.json({ error: 'Not authenticated' }, 401);
    if (!(await userHasFeature(authUser.id, authUser.role, 'memory'))) {
      return c.json({ error: 'Memory feature not enabled for your account' }, 403);
    }

    const id = toRowId(c.req.param('id'));
    if (!id) return c.json({ error: 'Invalid memory ID' }, 400);

    const body = (await c.req.json()) as {
      title?: string;
      content?: string;
      category?: UserMemoryCategory;
      pinned?: boolean;
      status?: UserMemoryStatus;
    };
    if (
      body.title === undefined &&
      body.content === undefined &&
      body.category === undefined &&
      body.pinned === undefined &&
      body.status === undefined
    ) {
      return c.json({ error: 'Nothing to update' }, 400);
    }

    const existing = await memoryServices(getDb()).userMemories.getOwned(id, authUser.id);
    if (!existing) return c.json({ error: 'Memory not found' }, 404);

    const check = validateMemoryText({ title: body.title, content: body.content });
    if (!check.ok) return c.json({ error: check.error }, 400);

    if (body.status !== undefined) {
      // Restoring, archiving, or waking a dormant memory. `superseded` is a
      // consolidation verdict, not something a user sets by hand.
      if (!['active', 'dormant', 'archived'].includes(body.status)) {
        return c.json({ error: 'Invalid status' }, 400);
      }
      await memoryServices(getDb()).userMemories.setStatus(id, authUser.id, body.status);
    }

    const updated =
      body.title !== undefined || body.content !== undefined || body.category !== undefined || body.pinned !== undefined
        ? await memoryServices(getDb()).userMemories.update(id, authUser.id, {
            title: body.title?.trim(),
            content: body.content?.trim(),
            category: body.category,
            pinned: body.pinned,
          })
        : await memoryServices(getDb()).userMemories.getOwned(id, authUser.id);

    return c.json(updated ?? null);
  })
  /** DELETE /api/auth/me/memories/:id — the one hard delete in the system */
  .delete('/:id', async (c) => {
    const authUser = getAuthUser(c);
    if (!authUser) return c.json({ error: 'Not authenticated' }, 401);
    if (!(await userHasFeature(authUser.id, authUser.role, 'memory'))) {
      return c.json({ error: 'Memory feature not enabled for your account' }, 403);
    }

    const id = toRowId(c.req.param('id'));
    if (!id) return c.json({ error: 'Invalid memory ID' }, 400);

    const existing = await memoryServices(getDb()).userMemories.getOwned(id, authUser.id);
    if (!existing) return c.json({ error: 'Memory not found' }, 404);

    await memoryServices(getDb()).userMemories.delete(id, authUser.id);
    return c.json({ deleted: true });
  });
