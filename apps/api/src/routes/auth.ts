/**
 * Auth routes — /api/auth
 *
 * POST /api/auth/login          — 内部用户邮箱密码登录
 * POST /api/auth/refresh        — 刷新access token（使用refresh token）
 * POST /api/auth/password-link/inspect  — 检查一次性账户设置/重置链接（不消费）
 * POST /api/auth/password-link/complete — 设置密码、消费链接并登录
 * GET  /api/auth/me             — 获取当前登录用户信息
 * GET  /api/auth/me/usage       — 获取当前用户用量统计
 * GET  /api/auth/me/preferences — 获取当前用户偏好notes
 * PUT  /api/auth/me/preferences — 更新当前用户偏好notes
 */

import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createAccessToken, createRefreshToken, hashRefreshToken } from '../auth/token.js';
import { getAuthUser } from '../auth/middleware.js';
import { resolveUserFeatures, userHasFeature } from '../auth/features.js';
import {
  getDb,
  hashAccountPasswordToken,
  type UserMemoryCategory,
  type UserMemoryStatus,
  type UserRow,
} from '@greenhouse/db';
import { sql } from 'drizzle-orm';
import { validateMemoryText } from '../llm/memory-limits.js';
import type { AppEnv } from '../app-env.js';
import { InMemoryRateLimiter } from '../security/security.js';
import { maskEmail, recordAccountSecurityAudit, resumeUserRuntime } from '../security/account.js';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';

const PASSWORD_LINK_BODY_LIMIT = 4096;
const PASSWORD_LINK_WINDOW_MS = 5 * 60_000;
const PASSWORD_LINK_TOKEN_LIMIT = 10;
const INVALID_PASSWORD_LINK_ERROR = 'This password link is invalid or expired.';
const passwordLinkTokenLimiter = new InMemoryRateLimiter();

function tokenRateKey(operation: 'inspect' | 'complete', token: string): string {
  const hash = hashAccountPasswordToken(token) ?? createHash('sha256').update(token, 'utf8').digest('hex');
  return `password-link:${operation}:${hash}`;
}

function passwordLinkRateLimitResponse(c: Context<AppEnv>, operation: 'inspect' | 'complete', token: string) {
  const result = passwordLinkTokenLimiter.check(
    tokenRateKey(operation, token),
    PASSWORD_LINK_WINDOW_MS,
    PASSWORD_LINK_TOKEN_LIMIT,
  );
  if (result.allowed) return null;
  c.header('Retry-After', String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))));
  return c.json({ error: 'Too many attempts. Please try again later.' }, 429);
}

function noStore(c: { header(name: string, value: string): void }): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

/**
 * Issue a normal access + refresh session for an already-authenticated user.
 *
 * Exported for the Feishu login exchange (routes/feishu-oauth.ts): scan login
 * must produce exactly the same session a password login would — same token
 * shapes, same `last_login_at` side effect — so it calls this rather than
 * growing a second issuance path.
 */
export async function issueUserSession(user: UserRow) {
  const accessToken = createAccessToken(user.id, user.role, user.auth_version);
  const refresh = createRefreshToken();
  await getDb().refreshTokens.create(user.id, refresh.hash, refresh.expiresAt, user.auth_version);
  await getDb().users.updateLastLogin(user.id);
  return {
    accessToken,
    refreshToken: refresh.raw,
    user: {
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      role: user.role,
      monthly_token_limit: user.monthly_token_limit,
      locale: user.locale ?? 'en',
    },
  };
}

const auth = new Hono<AppEnv>()
  .use(
    '/password-link/*',
    bodyLimit({
      maxSize: PASSWORD_LINK_BODY_LIMIT,
      onError: (c) => c.json({ error: 'Request body is too large.' }, 413),
    }),
  )
  .use('/password-link/*', async (c, next) => {
    noStore(c);
    await next();
    noStore(c);
  })
  // ─── One-time Account Password Links ────────────────────

  .post('/password-link/inspect', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
    const token = typeof body.token === 'string' ? body.token : '';
    const limited = passwordLinkRateLimitResponse(c, 'inspect', token);
    if (limited) return limited;

    const inspected = await getDb().accountPasswordLinks.inspect(token);
    if (!inspected) return c.json({ error: INVALID_PASSWORD_LINK_ERROR }, 400);
    return c.json({
      purpose: inspected.link.purpose,
      masked_email: maskEmail(inspected.user.email),
      expires_at: inspected.link.expires_at,
    });
  })
  .post('/password-link/complete', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { token?: unknown; password?: unknown };
    const token = typeof body.token === 'string' ? body.token : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const limited = passwordLinkRateLimitResponse(c, 'complete', token);
    if (limited) return limited;
    if (password.length < 8) return c.json({ error: 'Password must be at least 8 characters.' }, 400);

    // Avoid paying the scrypt cost for random probes. complete() repeats every
    // validation while holding user + link locks, so this is only a fast gate.
    if (!(await getDb().accountPasswordLinks.inspect(token))) {
      return c.json({ error: INVALID_PASSWORD_LINK_ERROR }, 400);
    }
    const passwordHash = await hashPassword(password);
    const completed = await getDb().accountPasswordLinks.complete(token, passwordHash);
    if (!completed) return c.json({ error: INVALID_PASSWORD_LINK_ERROR }, 400);

    try {
      await recordAccountSecurityAudit(getDb(), {
        actorId: completed.user.id,
        targetUserId: completed.user.id,
        linkId: completed.link.id,
        actionId: 'completeAccountPasswordLink',
        result: 'success',
        summary: { purpose: completed.link.purpose },
      });
    } catch (error) {
      // Activation has already committed and cannot be replayed. Report an
      // audit outage without turning a consumed link into a client failure.
      logger.error('[account-security] completion audit failed', toErrorMessage(error));
    }
    await resumeUserRuntime(completed.user.id);
    return c.json(await issueUserSession(completed.user));
  })
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

    if (user.status !== 'active') {
      return c.json({ error: 'Account is disabled. Contact your administrator.' }, 403);
    }

    if (user.role !== 'super' && user.role !== 'team') {
      return c.json({ error: 'This application is available to internal users only.' }, 403);
    }

    const valid = await verifyPassword(body.password, user.password_hash);
    if (!valid) {
      return c.json({ error: 'Invalid email or password' }, 401);
    }

    return c.json(await issueUserSession(user));
  })
  // ─── Token Refresh ───────────────────────────────────────

  /** POST /api/auth/refresh — exchange refresh token for new access + refresh pair */
  .post('/refresh', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { refreshToken?: string };

    if (!body.refreshToken) {
      return c.json({ error: 'Refresh token is required' }, 400);
    }

    const hash = hashRefreshToken(body.refreshToken);
    const tokenRow = await getDb().refreshTokens.consume(hash);

    if (!tokenRow) {
      return c.json({ error: 'Invalid or expired refresh token' }, 401);
    }

    const user = await getDb().users.getById(tokenRow.user_id);
    if (!user || user.status !== 'active') {
      return c.json({ error: 'Account not found or disabled' }, 401);
    }
    if (user.role !== 'super' && user.role !== 'team') {
      return c.json({ error: 'This application is available to internal users only.' }, 403);
    }
    if (tokenRow.auth_version !== user.auth_version) {
      return c.json({ error: 'Invalid or expired refresh token' }, 401);
    }

    const accessToken = createAccessToken(user.id, user.role, user.auth_version);
    const newRefresh = createRefreshToken();
    await getDb().refreshTokens.create(user.id, newRefresh.hash, newRefresh.expiresAt, user.auth_version);

    return c.json({
      accessToken,
      refreshToken: newRefresh.raw,
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        role: user.role,
        monthly_token_limit: user.monthly_token_limit,
        locale: user.locale ?? 'en',
      },
    });
  })
  // ─── Current User Info ───────────────────────────────────

  /** GET /api/auth/me — get current authenticated user info */
  .get('/me', async (c) => {
    const authUser = getAuthUser(c);

    const user = await getDb().users.getById(authUser.id);
    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Resolve effective feature flags (super-bypass + per-flag defaults).
    const features = await resolveUserFeatures(authUser.id, authUser.role).catch(() => ({}));

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        role: user.role,
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
        monthly_limit: user.monthly_token_limit,
      },
    });
  })
  // ─── User Preferences (Notes) ────────────────────────────

  /** GET /api/auth/me/preferences — get current user's preference notes */
  .get('/me/preferences', async (c) => {
    const authUser = getAuthUser(c);

    const user = await getDb().users.getById(authUser.id);
    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    return c.json({ notes: user.notes ?? null, locale: user.locale ?? 'en' });
  })
  /** PUT /api/auth/me/preferences — update current user's preference notes + locale */
  .put('/me/preferences', async (c) => {
    const authUser = getAuthUser(c);

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
  // ─── User Memories (self-service) ─────────────────
  // All three writes share one gate and one validator with the `memory` tool:
  // v1 gated only the GET, and gated it against the raw table so super users —
  // who are enabled by role, not by row — got a 403 on their own memories.

  /** GET /api/auth/me/memories — list the caller's memories (any status) */
  .get('/me/memories', async (c) => {
    const authUser = getAuthUser(c);
    if (!authUser) return c.json({ error: 'Not authenticated' }, 401);
    if (!(await userHasFeature(authUser.id, authUser.role, 'memory'))) {
      return c.json({ error: 'Memory feature not enabled for your account' }, 403);
    }

    const memories = await getDb().userMemories.listByUser(authUser.id);
    return c.json({ memories });
  })
  /** PATCH /api/auth/me/memories/:id — edit content/category/pinned, or move status */
  .patch('/me/memories/:id', async (c) => {
    const authUser = getAuthUser(c);
    if (!authUser) return c.json({ error: 'Not authenticated' }, 401);
    if (!(await userHasFeature(authUser.id, authUser.role, 'memory'))) {
      return c.json({ error: 'Memory feature not enabled for your account' }, 403);
    }

    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid memory ID' }, 400);

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

    const existing = await getDb().userMemories.getOwned(id, authUser.id);
    if (!existing) return c.json({ error: 'Memory not found' }, 404);

    const check = validateMemoryText({ title: body.title, content: body.content });
    if (!check.ok) return c.json({ error: check.error }, 400);

    if (body.status !== undefined) {
      // Restoring, archiving, or waking a dormant memory. `superseded` is a
      // consolidation verdict, not something a user sets by hand.
      if (!['active', 'dormant', 'archived'].includes(body.status)) {
        return c.json({ error: 'Invalid status' }, 400);
      }
      await getDb().userMemories.setStatus(id, authUser.id, body.status);
    }

    const updated =
      body.title !== undefined || body.content !== undefined || body.category !== undefined || body.pinned !== undefined
        ? await getDb().userMemories.update(id, authUser.id, {
            title: body.title?.trim(),
            content: body.content?.trim(),
            category: body.category,
            pinned: body.pinned,
          })
        : await getDb().userMemories.getOwned(id, authUser.id);

    return c.json(updated ?? null);
  })
  /** DELETE /api/auth/me/memories/:id — the one hard delete in the system */
  .delete('/me/memories/:id', async (c) => {
    const authUser = getAuthUser(c);
    if (!authUser) return c.json({ error: 'Not authenticated' }, 401);
    if (!(await userHasFeature(authUser.id, authUser.role, 'memory'))) {
      return c.json({ error: 'Memory feature not enabled for your account' }, 403);
    }

    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid memory ID' }, 400);

    const existing = await getDb().userMemories.getOwned(id, authUser.id);
    if (!existing) return c.json({ error: 'Memory not found' }, 404);

    await getDb().userMemories.delete(id, authUser.id);
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
