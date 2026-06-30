/**
 * Auth routes — /api/auth
 *
 * POST /api/auth/login          — 内部用户邮箱密码登录
 * POST /api/auth/login/external — 外部用户固定密码登录
 * POST /api/auth/refresh        — 刷新access token（使用refresh token）
 * GET  /api/auth/me             — 获取当前登录用户信息
 * GET  /api/auth/me/usage       — 获取当前用户用量统计
 * GET  /api/auth/me/preferences — 获取当前用户偏好notes
 * PUT  /api/auth/me/preferences — 更新当前用户偏好notes
 * GET  /api/auth/status         — 查询认证配置状态
 */

import { Hono } from 'hono';
import { verifyPassword } from '../auth/password.js';
import {
  createAccessToken,
  createRefreshToken,
  hashRefreshToken,
  verifyExternalPassword,
  isAuthEnabled,
} from '../auth/token.js';
import { getAuthUser } from '../auth/middleware.js';
import { resolveUserFeatures } from '../auth/features.js';
import { getDb } from '@greenhouse/db';
import { nowIso } from '@greenhouse/utils/date';
import { sql } from 'drizzle-orm';
import type { AppEnv } from '../app-env.js';

// ─── System User: external ───────────────────────────────

let _externalUserReady = false;

/** Ensure the 'external' system user exists in the DB (idempotent). */
async function ensureExternalUser(): Promise<void> {
  if (_externalUserReady) return;
  const existing = await getDb().users.getById('external');
  if (!existing) {
    const now = nowIso();
    try {
      await getDb().executeRaw(sql`
        INSERT INTO users (id, email, password_hash, nickname, role, status, daily_message_limit, monthly_token_limit, locale, created_at, updated_at)
        VALUES ('external', 'guest@system.local', 'NOLOGIN', 'Guest', 'external', 'active', 200, 20000000, 'en', ${now}, ${now})
        ON CONFLICT (id) DO NOTHING
      `);
    } catch {
      // Ignore — another request may have created it concurrently
    }
  }
  _externalUserReady = true;
}

const auth = new Hono<AppEnv>()
  // ─── Internal User Login ─────────────────────────────────

  /** POST /api/auth/login — email + password login for internal users */
  .post('/login', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      email?: string;
      password?: string;
    };

    if (!body.email || !body.password) {
      return c.json({ error: 'Email and password are required' }, 400);
    }

    const user = await getDb().users.getByEmail(body.email);
    if (!user) {
      return c.json({ error: 'Invalid email or password' }, 401);
    }

    if (user.status === 'disabled') {
      return c.json({ error: 'Account is disabled. Contact your administrator.' }, 403);
    }

    const valid = await verifyPassword(body.password, user.password_hash);
    if (!valid) {
      return c.json({ error: 'Invalid email or password' }, 401);
    }

    // Issue tokens
    const accessToken = createAccessToken(user.id, user.role);
    const refresh = createRefreshToken();
    await getDb().refreshTokens.create(user.id, refresh.hash, refresh.expiresAt);

    // Update last login
    await getDb().users.updateLastLogin(user.id);

    // Load assigned profiles
    const profiles =
      user.role !== 'external'
        ? [] // super/team have access to all profiles
        : await getDb().userProfiles.getProfiles(user.id);

    return c.json({
      accessToken,
      refreshToken: refresh.raw,
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        role: user.role,
        profiles,
        daily_message_limit: user.daily_message_limit,
        monthly_token_limit: user.monthly_token_limit,
        locale: user.locale ?? 'en',
      },
    });
  })
  // ─── External User Login ─────────────────────────────────

  /** POST /api/auth/login/external — fixed password login for beta testers */
  .post('/login/external', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { password?: string };

    if (!body.password) {
      return c.json({ error: 'Password is required' }, 400);
    }

    if (!verifyExternalPassword(body.password)) {
      return c.json({ error: 'Invalid password' }, 401);
    }

    // Ensure system user 'external' exists (first-run auto-seed)
    await ensureExternalUser();

    const accessToken = createAccessToken('external', 'external');
    // External users also get a refresh token for convenience
    const refresh = createRefreshToken();
    await getDb().refreshTokens.create('external', refresh.hash, refresh.expiresAt);

    return c.json({
      accessToken,
      refreshToken: refresh.raw,
      user: {
        id: 'external',
        nickname: 'Guest',
        role: 'external',
        profiles: [],
      },
    });
  })
  // ─── Token Refresh ───────────────────────────────────────

  /** POST /api/auth/refresh — exchange refresh token for new access + refresh pair */
  .post('/refresh', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { refreshToken?: string };

    if (!body.refreshToken) {
      return c.json({ error: 'Refresh token is required' }, 400);
    }

    const hash = hashRefreshToken(body.refreshToken);
    const tokenRow = await getDb().refreshTokens.validate(hash);

    if (!tokenRow) {
      return c.json({ error: 'Invalid or expired refresh token' }, 401);
    }

    // Revoke old refresh token (rotation)
    await getDb().refreshTokens.revoke(tokenRow.id);

    // For external users
    if (tokenRow.user_id === 'external') {
      const accessToken = createAccessToken('external', 'external');
      const newRefresh = createRefreshToken();
      await getDb().refreshTokens.create('external', newRefresh.hash, newRefresh.expiresAt);

      return c.json({
        accessToken,
        refreshToken: newRefresh.raw,
        user: {
          id: 'external',
          nickname: 'Guest',
          role: 'external',
          profiles: [],
        },
      });
    }

    // For internal users
    const user = await getDb().users.getById(tokenRow.user_id);
    if (!user || user.status === 'disabled') {
      return c.json({ error: 'Account not found or disabled' }, 401);
    }

    const accessToken = createAccessToken(user.id, user.role);
    const newRefresh = createRefreshToken();
    await getDb().refreshTokens.create(user.id, newRefresh.hash, newRefresh.expiresAt);

    const profiles = user.role !== 'external' ? [] : await getDb().userProfiles.getProfiles(user.id);

    return c.json({
      accessToken,
      refreshToken: newRefresh.raw,
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        role: user.role,
        profiles,
        daily_message_limit: user.daily_message_limit,
        monthly_token_limit: user.monthly_token_limit,
        locale: user.locale ?? 'en',
      },
    });
  })
  // ─── Current User Info ───────────────────────────────────

  /** GET /api/auth/me — get current authenticated user info */
  .get('/me', async (c) => {
    const authUser = getAuthUser(c);

    if (authUser.role === 'external' || authUser.id === 'external') {
      return c.json({
        user: {
          id: 'external',
          nickname: 'Guest',
          // const-asserted so the guest variant stays inside the contract's
          // AuthenticatedUser union (plain literals widen to string/never[])
          role: 'external' as const,
          profiles: [] as string[],
        },
      });
    }

    const user = await getDb().users.getById(authUser.id);
    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    const profiles = user.role !== 'external' ? [] : await getDb().userProfiles.getProfiles(user.id);

    // Resolve effective feature flags (super-bypass + per-flag defaults).
    const features = await resolveUserFeatures(authUser.id, authUser.role).catch(() => ({}));

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        role: user.role,
        profiles,
        daily_message_limit: user.daily_message_limit,
        monthly_token_limit: user.monthly_token_limit,
        notes: user.notes ?? null,
        locale: user.locale ?? 'en',
        features,
      },
    });
  })
  /** GET /api/auth/me/usage — get current user's usage stats */
  .get('/me/usage', async (c) => {
    const authUser = getAuthUser(c);

    if (authUser.role === 'external' || authUser.id === 'external') {
      return c.json({
        usage: {
          today_messages: 0,
          month_tokens: 0,
          daily_limit: 0,
          monthly_limit: 0,
        },
      });
    }

    const user = await getDb().users.getById(authUser.id);
    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    let todayMessages = 0;
    let monthTokens = 0;
    try {
      const msgRows = await getDb().executeRaw(sql`
        SELECT COUNT(*) as cnt FROM messages m
        JOIN sessions s ON m.session_id = s.id
        WHERE s.user_id = ${authUser.id} AND m.role = 'user' AND m.created_at >= ${todayStart}
      `);
      todayMessages = Number(msgRows[0]?.cnt ?? 0);

      const tokenRows = await getDb().executeRaw(sql`
        SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total
        FROM llm_usage WHERE user_id = ${authUser.id} AND created_at >= ${monthStart}
      `);
      monthTokens = Number(tokenRows[0]?.total ?? 0);
    } catch {
      /* Keep account menu non-blocking if usage tables are unavailable. */
    }

    return c.json({
      usage: {
        today_messages: todayMessages,
        month_tokens: monthTokens,
        daily_limit: user.daily_message_limit,
        monthly_limit: user.monthly_token_limit,
      },
    });
  })
  // ─── User Preferences (Notes) ────────────────────────────

  /** GET /api/auth/me/preferences — get current user's preference notes */
  .get('/me/preferences', async (c) => {
    const authUser = getAuthUser(c);

    if (authUser.role === 'external' || authUser.id === 'external') {
      return c.json({ notes: null });
    }

    const user = await getDb().users.getById(authUser.id);
    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    return c.json({ notes: user.notes ?? null, locale: user.locale ?? 'en' });
  })
  /** PUT /api/auth/me/preferences — update current user's preference notes + locale */
  .put('/me/preferences', async (c) => {
    const authUser = getAuthUser(c);

    if (authUser.role === 'external' || authUser.id === 'external') {
      return c.json({ error: 'External users cannot set preferences' }, 403);
    }

    const body = (await c.req.json().catch(() => ({}))) as { notes?: string; locale?: string };

    // Validate notes length (max 500 chars)
    const notes = body.notes ?? undefined;
    if (notes !== undefined && notes !== null && notes.length > 500) {
      return c.json({ error: 'Notes must be 500 characters or less' }, 400);
    }

    // Validate locale
    const validLocales = ['en', 'zh'];
    const locale = body.locale;
    if (locale !== undefined && !validLocales.includes(locale)) {
      return c.json({ error: `Invalid locale. Must be one of: ${validLocales.join(', ')}` }, 400);
    }

    const updates: Record<string, unknown> = {};
    if (notes !== undefined) updates.notes = notes || null;
    if (locale !== undefined) updates.locale = locale;

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No valid fields to update' }, 400);
    }

    const updated = await getDb().users.update(authUser.id, updates as { notes?: string | null; locale?: string });
    if (!updated) {
      return c.json({ error: 'User not found' }, 404);
    }

    return c.json({ notes: updated.notes ?? null, locale: updated.locale ?? 'en' });
  })
  // ─── Auth Status ─────────────────────────────────────────

  /** GET /api/auth/status — check if auth is enabled */
  .get('/status', async (c) => {
    return c.json({ authEnabled: isAuthEnabled() });
  })
  // ─── User Memories (self-service) ─────────────────

  /** GET /api/auth/me/memories — get current user's memories (requires memory feature) */
  .get('/me/memories', async (c) => {
    const authUser = getAuthUser(c);
    if (!authUser) return c.json({ error: 'Not authenticated' }, 401);

    const enabled = await getDb().userFeatures.isEnabled(authUser.id, 'memory');
    if (!enabled) return c.json({ error: 'Memory feature not enabled for your account' }, 403);

    const memories = await getDb().userMemories.listByUser(authUser.id, 50);
    return c.json({ memories });
  })
  /** PATCH /api/auth/me/memories/:id — update a memory */
  .patch('/me/memories/:id', async (c) => {
    const authUser = getAuthUser(c);
    if (!authUser) return c.json({ error: 'Not authenticated' }, 401);

    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid memory ID' }, 400);

    const body = (await c.req.json()) as { content?: string; category?: string };
    if (!body.content && !body.category) {
      return c.json({ error: 'Nothing to update' }, 400);
    }

    // Verify memory belongs to user
    const memories = await getDb().userMemories.listByUser(authUser.id, 100);
    const target = memories.find((m) => m.id === id);
    if (!target) return c.json({ error: 'Memory not found' }, 404);

    const updated = await getDb().userMemories.update(id, {
      content: body.content,
      category: body.category,
    });
    return c.json(updated);
  })
  /** DELETE /api/auth/me/memories/:id — delete a memory */
  .delete('/me/memories/:id', async (c) => {
    const authUser = getAuthUser(c);
    if (!authUser) return c.json({ error: 'Not authenticated' }, 401);

    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid memory ID' }, 400);

    // Verify memory belongs to user
    const memories = await getDb().userMemories.listByUser(authUser.id, 100);
    const target = memories.find((m) => m.id === id);
    if (!target) return c.json({ error: 'Memory not found' }, 404);

    await getDb().userMemories.delete(id);
    return c.json({ deleted: true });
  })
  /** GET /api/auth/me/features — get current user's feature flags */
  .get('/me/features', async (c) => {
    const authUser = getAuthUser(c);
    if (!authUser) return c.json({ error: 'Not authenticated' }, 401);

    const featureMap = await resolveUserFeatures(authUser.id, authUser.role);
    return c.json({ features: featureMap });
  });

// ─── Periodic Cleanup ────────────────────────────────────

// Clean up expired refresh tokens every hour
setInterval(async () => {
  try {
    const { getDb: getDbFn, isDbInitialized } = await import('@greenhouse/db');
    if (isDbInitialized()) {
      await getDbFn().refreshTokens.cleanup();
    }
  } catch {
    /* ignore during startup */
  }
}, 60 * 60_000).unref();

export default auth;
