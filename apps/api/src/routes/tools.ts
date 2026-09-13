/**
 * Tools route — /api/tools
 *
 * GET /api/tools — 获取当前用户可用的工具列表（含元数据）
 */

import { Hono } from 'hono';
import { getAuthUser } from '../auth/middleware.js';
import { getAllToolMetas } from '../tools/registry.js';
import { resolveUserTools } from '../agent.js';
import type { AppEnv } from '../app-env.js';

const tools = new Hono<AppEnv>()
  /**
   * GET /api/tools
   *
   * Returns tool metadata filtered by the user's role and assignments.
   * Each tool includes an `assigned` flag indicating whether the user can use it.
   */
  .get('/', async (c) => {
    const authUser = getAuthUser(c);

    const allMetas = getAllToolMetas();

    // Reuse the single authoritative allow-set resolver so this listing can never
    // drift from what the agent actually grants (super = all, team = global ∪ assigned).
    const { allowedTools } = await resolveUserTools(authUser.id, authUser.role);
    const assignedToolIds = new Set(allowedTools);

    // Return only tools the user can see, with assigned flag
    const result = allMetas
      .filter((t) => assignedToolIds.has(t.id))
      .map((t) => ({
        id: t.id,
        name: t.name,
        brief: t.brief,
        category: t.category,
        is_global: t.is_global,
        // Every Agent gets these regardless of what its author picked, so the
        // Agent editor leaves them out of the pick list entirely.
        builtin: t.builtin === true,
        icon: t.icon,
        surface: t.surface,
      }));

    return c.json({ tools: result });
  });

export default tools;
