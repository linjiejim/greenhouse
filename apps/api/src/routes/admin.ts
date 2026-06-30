/**
 * Admin routes — /api/admin
 *
 * === 用户管理（super only） ===
 * POST   /api/admin/users                  — 创建内部用户
 * GET    /api/admin/users                  — 获取用户列表
 * GET    /api/admin/users/:id              — 获取用户详情（含用量统计）
 * PATCH  /api/admin/users/:id              — 更新用户（昵称/角色/状态/限额）
 * DELETE /api/admin/users/:id              — 删除用户（级联删除关联数据）
 * POST   /api/admin/users/:id/reset-password — 重置用户密码
 *
 * === Profile 分配（super only） ===
 * GET    /api/admin/users/:id/profiles     — 获取用户已分配profiles
 * PUT    /api/admin/users/:id/profiles     — 设置用户profiles（全量替换）
 *
 * === 工具分配（super only） ===
 * GET    /api/admin/users/:id/tools        — 获取用户已分配工具
 * PUT    /api/admin/users/:id/tools        — 设置用户工具（全量替换）
 *
 * === 用量查看（super only） ===
 * GET    /api/admin/users/:id/usage        — 查看指定用户用量
 * GET    /api/admin/usage/summary          — 全部用户用量汇总
 */

import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { getDb } from '@greenhouse/db';
import { hashPassword } from '../auth/password.js';
import { getAuthUser } from '../auth/middleware.js';
import { listProfileIds } from '../profile.js';
import { getAllToolIds } from '../tools/registry.js';
import type { AppEnv } from '../app-env.js';

// ─── Helper: execute raw SQL on the DB ───────────────────
async function execSql(query: ReturnType<typeof sql>): Promise<any[]> {
  return getDb().executeRaw(query);
}

const admin = new Hono<AppEnv>()
  // ─── User CRUD ───────────────────────────────────────────

  /** POST /api/admin/users — create a new internal user */
  .post('/users', async (c) => {
    const currentUser = getAuthUser(c);
    const body = (await c.req.json()) as {
      email?: string;
      password?: string;
      nickname?: string;
      role?: 'team' | 'external';
      daily_message_limit?: number;
      monthly_token_limit?: number;
    };

    if (!body.email || !body.password || !body.nickname) {
      return c.json({ error: 'email, password, and nickname are required' }, 400);
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      return c.json({ error: 'Invalid email format' }, 400);
    }

    if (body.password.length < 8) {
      return c.json({ error: 'Password must be at least 8 characters' }, 400);
    }

    const VALID_ROLES = ['team', 'external'] as const;
    const role = body.role ?? 'team';
    if (!VALID_ROLES.includes(role as (typeof VALID_ROLES)[number])) {
      return c.json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` }, 400);
    }

    const existing = await getDb().users.getByEmail(body.email);
    if (existing) {
      return c.json({ error: 'A user with this email already exists' }, 409);
    }

    const password_hash = await hashPassword(body.password);

    const user = await getDb().users.create({
      email: body.email,
      password_hash,
      nickname: body.nickname,
      role,
      daily_message_limit: body.daily_message_limit,
      monthly_token_limit: body.monthly_token_limit,
      created_by: currentUser.id,
    });

    return c.json(
      {
        user: {
          id: user.id,
          email: user.email,
          nickname: user.nickname,
          role: user.role,
          status: user.status,
          daily_message_limit: user.daily_message_limit,
          monthly_token_limit: user.monthly_token_limit,
          created_at: user.created_at,
        },
      },
      201,
    );
  })
  /** GET /api/admin/users — list all users */
  .get('/users', async (c) => {
    const users = await getDb().users.list();

    // Enrich with usage summary via SQL
    const usageSummaries = new Map<
      string,
      { total_calls: number; month_tokens: number; today_messages: number; last_used_at: string | null }
    >();
    try {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

      const usageRows = await execSql(sql`
        SELECT user_id,
          COUNT(*) as total_calls,
          COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
          MAX(created_at) as last_used_at
        FROM llm_usage
        WHERE user_id IS NOT NULL
        GROUP BY user_id
      `);

      for (const row of usageRows) {
        usageSummaries.set(row.user_id, {
          total_calls: Number(row.total_calls),
          month_tokens: 0,
          today_messages: 0,
          last_used_at: row.last_used_at,
        });
      }

      const monthRows = await execSql(sql`
        SELECT user_id, COALESCE(SUM(input_tokens + output_tokens), 0) as month_tokens
        FROM llm_usage WHERE user_id IS NOT NULL AND created_at >= ${monthStart}
        GROUP BY user_id
      `);
      for (const row of monthRows) {
        const s = usageSummaries.get(row.user_id);
        if (s) s.month_tokens = Number(row.month_tokens);
      }

      const msgRows = await execSql(sql`
        SELECT s.user_id, COUNT(*) as cnt
        FROM messages m JOIN sessions s ON m.session_id = s.id
        WHERE s.user_id IS NOT NULL AND m.role = 'user' AND m.created_at >= ${todayStart}
        GROUP BY s.user_id
      `);
      for (const row of msgRows) {
        const s = usageSummaries.get(row.user_id);
        if (s) s.today_messages = Number(row.cnt);
        else
          usageSummaries.set(row.user_id, {
            total_calls: 0,
            month_tokens: 0,
            today_messages: Number(row.cnt),
            last_used_at: null,
          });
      }
    } catch {
      /* ignore */
    }

    return c.json({
      users: users.map((u) => {
        const usage = usageSummaries.get(u.id);
        return {
          id: u.id,
          email: u.email,
          nickname: u.nickname,
          role: u.role,
          status: u.status,
          daily_message_limit: u.daily_message_limit,
          monthly_token_limit: u.monthly_token_limit,
          created_by: u.created_by,
          created_at: u.created_at,
          updated_at: u.updated_at,
          last_login_at: u.last_login_at,
          usage_summary: usage
            ? {
                total_calls: usage.total_calls,
                today_messages: usage.today_messages,
                month_tokens: usage.month_tokens,
                last_used_at: usage.last_used_at,
              }
            : null,
        };
      }),
    });
  })
  /** GET /api/admin/users/:id — get user detail with usage stats */
  .get('/users/:id', async (c) => {
    const id = c.req.param('id');
    const user = await getDb().users.getById(id);
    if (!user) return c.json({ error: 'User not found' }, 404);

    const profiles = await getDb().userProfiles.getProfiles(id);

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    let todayMessages = 0;
    let monthTokens = 0;
    try {
      const msgRows = await execSql(sql`
        SELECT COUNT(*) as cnt FROM messages m
        JOIN sessions s ON m.session_id = s.id
        WHERE s.user_id = ${id} AND m.role = 'user' AND m.created_at >= ${todayStart}
      `);
      todayMessages = Number(msgRows[0]?.cnt ?? 0);

      const tokenRows = await execSql(sql`
        SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total
        FROM llm_usage WHERE user_id = ${id} AND created_at >= ${monthStart}
      `);
      monthTokens = Number(tokenRows[0]?.total ?? 0);
    } catch {
      /* ignore */
    }

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        role: user.role,
        status: user.status,
        daily_message_limit: user.daily_message_limit,
        monthly_token_limit: user.monthly_token_limit,
        created_by: user.created_by,
        created_at: user.created_at,
        updated_at: user.updated_at,
        last_login_at: user.last_login_at,
        notes: user.notes ?? null,
      },
      profiles,
      usage: {
        today_messages: todayMessages,
        month_tokens: monthTokens,
        daily_limit: user.daily_message_limit,
        monthly_limit: user.monthly_token_limit,
      },
    });
  })
  /** PATCH /api/admin/users/:id — update user */
  .patch('/users/:id', async (c) => {
    const id = c.req.param('id');
    const currentUser = getAuthUser(c);
    const body = (await c.req.json()) as {
      nickname?: string;
      role?: 'team' | 'external';
      status?: 'active' | 'disabled';
      daily_message_limit?: number;
      monthly_token_limit?: number;
    };

    const user = await getDb().users.getById(id);
    if (!user) return c.json({ error: 'User not found' }, 404);

    if (user.role === 'super' && user.id !== currentUser.id) {
      return c.json({ error: 'Cannot modify another super admin' }, 403);
    }

    if ((body.role as string) === 'super') {
      return c.json({ error: 'Cannot assign super role via API' }, 400);
    }

    const VALID_ROLES = ['team', 'external'] as const;
    if (body.role !== undefined && !VALID_ROLES.includes(body.role as (typeof VALID_ROLES)[number])) {
      return c.json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` }, 400);
    }

    if (body.status === 'disabled' && user.status === 'active') {
      await getDb().refreshTokens.revokeAllForUser(id);
    }

    const updated = await getDb().users.update(id, body);
    if (!updated) return c.json({ error: 'User not found' }, 404);

    return c.json({
      user: {
        id: updated.id,
        email: updated.email,
        nickname: updated.nickname,
        role: updated.role,
        status: updated.status,
        daily_message_limit: updated.daily_message_limit,
        monthly_token_limit: updated.monthly_token_limit,
      },
    });
  })
  /** DELETE /api/admin/users/:id — hard-delete a user */
  .delete('/users/:id', async (c) => {
    const id = c.req.param('id');
    const user = await getDb().users.getById(id);
    if (!user) return c.json({ error: 'User not found' }, 404);

    if (user.role === 'super') {
      return c.json({ error: 'Cannot delete super admin' }, 403);
    }

    const deleted = await getDb().users.delete(id);
    if (!deleted) return c.json({ error: 'Delete failed' }, 500);

    return c.json({ ok: true });
  })
  /** POST /api/admin/users/:id/reset-password — reset user password */
  .post('/users/:id/reset-password', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as { password?: string };

    if (!body.password || body.password.length < 8) {
      return c.json({ error: 'Password must be at least 8 characters' }, 400);
    }

    const user = await getDb().users.getById(id);
    if (!user) return c.json({ error: 'User not found' }, 404);

    if (user.role === 'super') {
      return c.json({ error: 'Cannot reset super admin password via API' }, 403);
    }

    const password_hash = await hashPassword(body.password);
    await getDb().users.update(id, { password_hash });
    await getDb().refreshTokens.revokeAllForUser(id);

    return c.json({ ok: true });
  })
  // ─── Profile Assignment ──────────────────────────────────

  /** GET /api/admin/users/:id/profiles — get assigned profiles */
  .get('/users/:id/profiles', async (c) => {
    const id = c.req.param('id');
    const user = await getDb().users.getById(id);
    if (!user) return c.json({ error: 'User not found' }, 404);

    const assigned = await getDb().userProfiles.getProfiles(id);
    const available = listProfileIds();

    return c.json({ assigned, available });
  })
  /** PUT /api/admin/users/:id/profiles — set assigned profiles (full replace) */
  .put('/users/:id/profiles', async (c) => {
    const id = c.req.param('id');
    const currentUser = getAuthUser(c);
    const body = (await c.req.json()) as { profiles?: string[] };

    if (!Array.isArray(body.profiles)) {
      return c.json({ error: 'profiles must be an array of profile IDs' }, 400);
    }

    const user = await getDb().users.getById(id);
    if (!user) return c.json({ error: 'User not found' }, 404);

    const available = new Set(listProfileIds());
    const invalid = body.profiles.filter((p) => !available.has(p));
    if (invalid.length > 0) {
      return c.json({ error: `Unknown profiles: ${invalid.join(', ')}` }, 400);
    }

    await getDb().userProfiles.setProfiles(id, body.profiles, currentUser.id);

    return c.json({ ok: true, profiles: body.profiles });
  })
  // ─── Tool Assignment ─────────────────────────────────────

  /** GET /api/admin/users/:id/tools — get assigned tools */
  .get('/users/:id/tools', async (c) => {
    const id = c.req.param('id');
    const user = await getDb().users.getById(id);
    if (!user) return c.json({ error: 'User not found' }, 404);

    const assigned = await getDb().userTools.getTools(id);
    const available = getAllToolIds();

    return c.json({ assigned, available });
  })
  /** PUT /api/admin/users/:id/tools — set assigned tools (full replace) */
  .put('/users/:id/tools', async (c) => {
    const id = c.req.param('id');
    const currentUser = getAuthUser(c);
    const body = (await c.req.json()) as { tools?: string[] };

    if (!Array.isArray(body.tools)) {
      return c.json({ error: 'tools must be an array of tool IDs' }, 400);
    }

    const user = await getDb().users.getById(id);
    if (!user) return c.json({ error: 'User not found' }, 404);

    const available = new Set(getAllToolIds());
    const invalid = body.tools.filter((t) => !available.has(t));
    if (invalid.length > 0) {
      return c.json({ error: `Unknown tools: ${invalid.join(', ')}` }, 400);
    }

    await getDb().userTools.setTools(id, body.tools, currentUser.id);

    return c.json({ ok: true, tools: body.tools });
  })
  // ─── Usage Viewing ───────────────────────────────────────

  /** GET /api/admin/users/:id/usage — get user's LLM usage */
  .get('/users/:id/usage', async (c) => {
    const id = c.req.param('id');
    const since = c.req.query('since') || undefined;

    const user = await getDb().users.getById(id);
    if (!user && id !== 'external') return c.json({ error: 'User not found' }, 404);

    try {
      const sinceClause = since ? sql`AND created_at >= ${since}` : sql``;
      const statsRows = await execSql(sql`
        SELECT
          COUNT(*) as total_calls,
          COALESCE(SUM(input_tokens), 0) as total_input_tokens,
          COALESCE(SUM(output_tokens), 0) as total_output_tokens,
          COALESCE(SUM(cached_tokens), 0) as total_cached_tokens,
          COALESCE(SUM(reasoning_tokens), 0) as total_reasoning_tokens,
          COALESCE(SUM(duration_ms), 0) as total_duration_ms
        FROM llm_usage
        WHERE user_id = ${id} ${sinceClause}
      `);

      const recentRows = await execSql(sql`
        SELECT id, profile_id, caller, session_id, model,
               input_tokens, output_tokens, cached_tokens,
               reasoning_tokens, duration_ms, created_at
        FROM llm_usage
        WHERE user_id = ${id}
        ORDER BY created_at DESC LIMIT 20
      `);

      return c.json({ stats: statsRows[0] ?? null, recent: recentRows });
    } catch {
      return c.json({ stats: null, recent: [] });
    }
  })
  /** GET /api/admin/usage/summary — all users usage overview */
  .get('/usage/summary', async (c) => {
    const since = c.req.query('since') || undefined;

    try {
      const sinceClause = since ? sql`AND created_at >= ${since}` : sql``;
      const byUser = await execSql(sql`
        SELECT
          user_id,
          COUNT(*) as total_calls,
          COALESCE(SUM(input_tokens), 0) as total_input_tokens,
          COALESCE(SUM(output_tokens), 0) as total_output_tokens,
          MAX(created_at) as last_used_at
        FROM llm_usage
        WHERE user_id IS NOT NULL ${sinceClause}
        GROUP BY user_id
        ORDER BY total_calls DESC
      `);

      const users = await getDb().users.list();
      const userMap = new Map(users.map((u) => [u.id, u]));

      // Explicit shape: raw SQL rows are any[] (which would erase this route
      // from the hc contract) and postgres.js returns COUNT/SUM bigints as
      // strings — Number() makes the wire match the declared contract.
      const enriched = byUser.map((row: any) => ({
        user_id: row.user_id as string,
        total_calls: Number(row.total_calls),
        total_input_tokens: Number(row.total_input_tokens),
        total_output_tokens: Number(row.total_output_tokens),
        last_used_at: (row.last_used_at as string | null) ?? null,
        nickname: userMap.get(row.user_id)?.nickname ?? (row.user_id === 'external' ? 'Guest' : 'Unknown'),
        role: userMap.get(row.user_id)?.role ?? (row.user_id === 'external' ? 'external' : 'unknown'),
      }));

      return c.json({ by_user: enriched });
    } catch {
      return c.json({ by_user: [] });
    }
  })
  // ─── Feature Gate Management (super only) ────────────────

  /** GET /api/admin/users/:id/features — get a user's feature toggles */
  .get('/users/:id/features', async (c) => {
    const userId = c.req.param('id');
    const features = await getDb().userFeatures.listByUser(userId);
    return c.json({ features });
  })
  /** PUT /api/admin/users/:id/features — toggle a feature for a user */
  .put('/users/:id/features', async (c) => {
    const userId = c.req.param('id');
    const body = (await c.req.json()) as { feature: string; enabled: boolean };
    if (!body.feature || typeof body.enabled !== 'boolean') {
      return c.json({ error: 'feature and enabled are required' }, 400);
    }
    const targetUser = await getDb().users.getById(userId);
    if (!targetUser) return c.json({ error: 'User not found' }, 404);

    const currentUser = getAuthUser(c);
    const result = await getDb().userFeatures.upsert({
      user_id: userId,
      feature: body.feature,
      enabled: body.enabled,
      granted_by: currentUser?.id,
    });
    return c.json(result);
  })
  /** PUT /api/admin/features — set a user's feature toggle */
  .put('/features', async (c) => {
    const body = (await c.req.json()) as {
      user_id: string;
      feature: string;
      enabled: boolean;
      config?: Record<string, unknown>;
    };

    if (!body.user_id || !body.feature || typeof body.enabled !== 'boolean') {
      return c.json({ error: 'user_id, feature, and enabled are required' }, 400);
    }

    // Verify target user exists
    const targetUser = await getDb().users.getById(body.user_id);
    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404);
    }

    const currentUser = getAuthUser(c);
    const result = await getDb().userFeatures.upsert({
      user_id: body.user_id,
      feature: body.feature,
      enabled: body.enabled,
      config: body.config,
      granted_by: currentUser?.id,
    });

    return c.json(result);
  })
  /** GET /api/admin/features/:feature — get all user states for a feature */
  .get('/features/:feature', async (c) => {
    const feature = c.req.param('feature');
    const records = await getDb().userFeatures.listByFeature(feature);

    // Enrich with user info
    const users = await getDb().users.list();
    const userMap = new Map(users.map((u) => [u.id, { nickname: u.nickname, email: u.email, role: u.role }]));

    const enriched = records.map((r) => ({
      ...r,
      user: userMap.get(r.user_id) ?? { nickname: 'Unknown', email: '', role: 'unknown' },
    }));

    return c.json({ feature, users: enriched });
  });

export default admin;
