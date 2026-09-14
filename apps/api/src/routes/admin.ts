/**
 * Admin routes — /api/admin
 *
 * === 用户管理（super only） ===
 * POST   /api/admin/users                  — 创建内部用户
 * GET    /api/admin/users                  — 获取用户列表
 * GET    /api/admin/users/:id              — 获取用户详情（含用量统计）
 * PATCH  /api/admin/users/:id              — 更新用户（昵称/角色/状态/月度 Token 上限）
 * DELETE /api/admin/users/:id              — 删除用户（级联删除关联数据）
 * POST   /api/admin/users/:id/reset-password — 重置用户密码
 * POST   /api/admin/users/:id/password-link/resend — 重发当前账户设置/重置链接
 * POST   /api/admin/users/:id/password-link/revoke — 撤销当前账户设置/重置链接
 *
 * === 工具分配（super only） ===
 * GET    /api/admin/users/:id/tools        — 获取用户已分配工具
 * PUT    /api/admin/users/:id/tools        — 设置用户工具（全量替换）
 *
 * === 用量查看（super only） ===
 * GET    /api/admin/users/:id/usage        — 查看指定用户用量
 * GET    /api/admin/usage/summary          — 全部用户用量汇总
 */

import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { sql } from 'drizzle-orm';
import {
  getDb,
  UNSET_ACCOUNT_PASSWORD_HASH,
  type AccountPasswordLinkRow,
  type IssuedAccountPasswordLink,
} from '@greenhouse/db';
import { hashPassword } from '../auth/password.js';
import { getAuthUser } from '../auth/middleware.js';
import { getAllToolIds } from '../tools/registry.js';
import { FEATURE_OWNED_TOOL_IDS, buildUserAccessView } from '../platform/feature-points.js';
import type { AppEnv } from '../app-env.js';
import {
  deliverAccountPasswordLink,
  getPasswordLinkCapability,
  recordAccountSecurityAudit,
  resumeUserRuntime,
  suspendUserRuntime,
} from '../security/account.js';

const RETIRED_EXTERNAL_PASSWORD_HASH = 'EXTERNAL_ACCOUNT_RETIRED_NOLOGIN';

function safePasswordLink(link: AccountPasswordLinkRow) {
  return {
    id: link.id,
    purpose: link.purpose,
    expires_at: link.expires_at,
    created_at: link.created_at,
    sent_at: link.sent_at,
    delivery_status: link.delivery_status,
    delivery_error: link.delivery_error,
  };
}

function requestId(c: Context): string {
  return c.req.header('x-request-id')?.trim() || randomUUID();
}

async function deliverIssuedLink(
  c: Context,
  issued: IssuedAccountPasswordLink,
  actionId: 'issueAccountInvite' | 'issuePasswordReset' | 'resendAccountPasswordLink',
) {
  const db = getDb();
  const actor = getAuthUser(c);
  const inviter = await db.users.getById(actor.id);
  if (!inviter) throw new Error('Authenticated administrator no longer exists');
  const auditRequestId = requestId(c);

  await recordAccountSecurityAudit(db, {
    actorId: actor.id,
    requestId: auditRequestId,
    targetUserId: issued.user.id,
    linkId: issued.link.id,
    actionId,
    result: 'success',
    summary: { purpose: issued.link.purpose, expires_at: issued.link.expires_at },
  });
  const delivery = await deliverAccountPasswordLink(db, issued, inviter);
  const stored = await db.accountPasswordLinks.markDelivery(
    issued.link.id,
    delivery.ok ? 'sent' : 'failed',
    delivery.ok ? undefined : delivery.error,
  );
  if (!delivery.ok) {
    await recordAccountSecurityAudit(db, {
      actorId: actor.id,
      requestId: auditRequestId,
      targetUserId: issued.user.id,
      linkId: issued.link.id,
      actionId: 'deliverAccountPasswordLink',
      result: 'error',
      summary: { purpose: issued.link.purpose, error: delivery.error },
    });
  }
  return {
    password_link: safePasswordLink(stored ?? issued.link),
    delivery: delivery.ok ? { status: 'sent' as const } : { status: 'failed' as const, error: delivery.error },
  };
}

function unavailablePasswordLinkResponse(c: Context<AppEnv>) {
  const capability = getPasswordLinkCapability();
  return capability.available
    ? null
    : c.json({ error: 'Email password links are unavailable on this deployment.', reason: capability.reason }, 503);
}

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
      role?: 'team';
      credential_mode?: 'email_link' | 'direct_password';
      monthly_token_limit?: number;
    };

    if (!body.email || !body.nickname) {
      return c.json({ error: 'email and nickname are required' }, 400);
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      return c.json({ error: 'Invalid email format' }, 400);
    }

    const credentialMode = body.credential_mode ?? (body.password ? 'direct_password' : 'email_link');
    if (credentialMode !== 'email_link' && credentialMode !== 'direct_password') {
      return c.json({ error: 'credential_mode must be email_link or direct_password' }, 400);
    }
    if (credentialMode === 'direct_password' && (!body.password || body.password.length < 8)) {
      return c.json({ error: 'Password must be at least 8 characters' }, 400);
    }
    if (credentialMode === 'email_link') {
      const unavailable = unavailablePasswordLinkResponse(c);
      if (unavailable) return unavailable;
    }

    const role = body.role ?? 'team';
    if (role !== 'team') {
      return c.json({ error: 'Role must be team' }, 400);
    }

    const existing = await getDb().users.getByEmail(body.email);
    if (existing) {
      return c.json({ error: 'A user with this email already exists' }, 409);
    }

    const password_hash =
      credentialMode === 'direct_password' ? await hashPassword(body.password!) : UNSET_ACCOUNT_PASSWORD_HASH;

    const user = await getDb().users.create({
      email: body.email,
      password_hash,
      nickname: body.nickname,
      role,
      status: credentialMode === 'email_link' ? 'invited' : 'active',
      monthly_token_limit: body.monthly_token_limit,
      created_by: currentUser.id,
    });
    await getDb().platform.syncLegacyRoleBinding(user.id, user.role, currentUser.id);

    let linkResult: Awaited<ReturnType<typeof deliverIssuedLink>> | undefined;
    if (credentialMode === 'email_link') {
      const issued = await getDb().accountPasswordLinks.issueInvite(user.id, currentUser.id);
      if (!issued) return c.json({ error: 'Failed to issue account setup link' }, 500);
      linkResult = await deliverIssuedLink(c, issued, 'issueAccountInvite');
    }

    return c.json(
      {
        user: {
          id: user.id,
          email: user.email,
          nickname: user.nickname,
          role: user.role,
          status: user.status,
          monthly_token_limit: user.monthly_token_limit,
          created_at: user.created_at,
        },
        ...(linkResult ?? {}),
      },
      201,
    );
  })
  /** GET /api/admin/users — list all users */
  .get('/users', async (c) => {
    const [users, currentLinks] = await Promise.all([getDb().users.list(), getDb().accountPasswordLinks.listCurrent()]);
    const passwordLinks = new Map(currentLinks.map((link) => [link.user_id, link]));

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
          password_link: passwordLinks.get(u.id) ? safePasswordLink(passwordLinks.get(u.id)!) : null,
        };
      }),
      password_link_capability: getPasswordLinkCapability(),
    });
  })
  /** GET /api/admin/users/:id — get user detail with usage stats */
  .get('/users/:id', async (c) => {
    const id = c.req.param('id');
    const user = await getDb().users.getById(id);
    if (!user) return c.json({ error: 'User not found' }, 404);

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
        monthly_token_limit: user.monthly_token_limit,
        created_by: user.created_by,
        created_at: user.created_at,
        updated_at: user.updated_at,
        last_login_at: user.last_login_at,
        notes: user.notes ?? null,
      },
      usage: {
        today_messages: todayMessages,
        month_tokens: monthTokens,
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
      role?: 'team';
      status?: 'active' | 'disabled';
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

    if (body.role !== undefined && body.role !== 'team') {
      return c.json({ error: 'Role must be team' }, 400);
    }

    if (body.status === 'active' && user.role === 'external' && body.role !== 'team') {
      return c.json({ error: 'Historical external accounts must be converted to team before activation' }, 409);
    }

    if (body.status === 'active' && user.password_hash === RETIRED_EXTERNAL_PASSWORD_HASH) {
      return c.json({ error: 'Reset this retired external account password before activation' }, 409);
    }

    if (
      body.status === 'active' &&
      (user.status === 'invited' ||
        user.status === 'reset_required' ||
        user.password_hash === UNSET_ACCOUNT_PASSWORD_HASH)
    ) {
      return c.json({ error: 'Set a password before activating this account' }, 409);
    }

    // Build the public update surface explicitly. The retired
    // daily_message_limit column remains in storage for compatibility, but an
    // old client must not be able to keep mutating it by sending an extra key.
    const updates = {
      ...(body.nickname !== undefined ? { nickname: body.nickname } : {}),
      ...(body.role !== undefined ? { role: body.role } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.monthly_token_limit !== undefined ? { monthly_token_limit: body.monthly_token_limit } : {}),
    };
    const db = getDb();
    const credentialsRevoked = body.status === 'disabled' && user.status !== 'disabled';
    const updated = credentialsRevoked
      ? await db.users.updateAndRevokeSessions(id, updates)
      : await db.users.update(id, updates);
    if (!updated) return c.json({ error: 'User not found' }, 404);
    if (body.role !== undefined) {
      await getDb().platform.syncLegacyRoleBinding(updated.id, updated.role, currentUser.id);
    }
    if (body.monthly_token_limit !== undefined) {
      // Keep the materialized current-month hard-budget account in sync for
      // immediate admin visibility. The service re-reads users under a lock,
      // so stale request copies cannot raise this limit again.
      await db.usageBudget.ensureMonthlyUserAccount({
        user_id: updated.id,
        limit_tokens: updated.monthly_token_limit,
        sync_limit: true,
      });
    }
    if (credentialsRevoked) await suspendUserRuntime(id);
    if (body.status === 'active' && user.status === 'disabled') await resumeUserRuntime(id);

    return c.json({
      user: {
        id: updated.id,
        email: updated.email,
        nickname: updated.nickname,
        role: updated.role,
        status: updated.status,
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
    const body = (await c.req.json()) as { mode?: 'email_link' | 'direct_password'; password?: string };
    const mode = body.mode ?? (body.password ? 'direct_password' : 'email_link');
    if (mode !== 'email_link' && mode !== 'direct_password') {
      return c.json({ error: 'mode must be email_link or direct_password' }, 400);
    }

    const user = await getDb().users.getById(id);
    if (!user) return c.json({ error: 'User not found' }, 404);

    if (user.role === 'super') {
      return c.json({ error: 'Cannot reset super admin password via API' }, 403);
    }

    if (mode === 'email_link') {
      const unavailable = unavailablePasswordLinkResponse(c);
      if (unavailable) return unavailable;
      if (user.status === 'disabled') return c.json({ error: 'Disabled accounts cannot receive password links' }, 409);

      const issued =
        user.status === 'invited'
          ? await getDb().accountPasswordLinks.issueInvite(id, getAuthUser(c).id)
          : await getDb().accountPasswordLinks.issueReset(id, getAuthUser(c).id);
      if (!issued) return c.json({ error: 'Account is not eligible for a password link' }, 409);
      await suspendUserRuntime(id);
      const delivered = await deliverIssuedLink(
        c,
        issued,
        issued.link.purpose === 'invite' ? 'issueAccountInvite' : 'issuePasswordReset',
      );
      return c.json({ ok: true, user: { id: issued.user.id, status: issued.user.status }, ...delivered });
    }

    if (!body.password || body.password.length < 8) {
      return c.json({ error: 'Password must be at least 8 characters' }, 400);
    }

    const password_hash = await hashPassword(body.password);
    const updated = await getDb().users.resetPasswordAndRevokeSessions(id, password_hash);
    if (!updated) return c.json({ error: 'User not found' }, 404);

    await recordAccountSecurityAudit(getDb(), {
      actorId: getAuthUser(c).id,
      requestId: requestId(c),
      targetUserId: id,
      actionId: 'setUserPasswordDirectly',
      result: 'success',
      summary: { status: updated.status },
    });
    if (updated.status === 'active') await resumeUserRuntime(id);

    return c.json({ ok: true, user: { id: updated.id, status: updated.status } });
  })
  /** POST /api/admin/users/:id/password-link/resend — revoke old and issue a fresh current-state link */
  .post('/users/:id/password-link/resend', async (c) => {
    const unavailable = unavailablePasswordLinkResponse(c);
    if (unavailable) return unavailable;
    const id = c.req.param('id');
    const user = await getDb().users.getById(id);
    if (!user) return c.json({ error: 'User not found' }, 404);
    if (user.role === 'super') return c.json({ error: 'Cannot manage super admin password links via API' }, 403);

    const issued = await getDb().accountPasswordLinks.resend(id, getAuthUser(c).id);
    if (!issued) return c.json({ error: 'Account has no pending password setup state' }, 409);
    const delivered = await deliverIssuedLink(c, issued, 'resendAccountPasswordLink');
    return c.json({ ok: true, ...delivered });
  })
  /** POST /api/admin/users/:id/password-link/revoke — revoke without restoring credentials */
  .post('/users/:id/password-link/revoke', async (c) => {
    const id = c.req.param('id');
    const user = await getDb().users.getById(id);
    if (!user) return c.json({ error: 'User not found' }, 404);
    if (user.role === 'super') return c.json({ error: 'Cannot manage super admin password links via API' }, 403);

    const link = await getDb().accountPasswordLinks.revokeCurrent(id);
    if (!link) return c.json({ error: 'No current password link' }, 404);
    await recordAccountSecurityAudit(getDb(), {
      actorId: getAuthUser(c).id,
      requestId: requestId(c),
      targetUserId: id,
      linkId: link.id,
      actionId: 'revokeAccountPasswordLink',
      result: 'success',
      summary: { purpose: link.purpose },
    });
    return c.json({ ok: true });
  })
  // ─── Unified Access View (feature-point aggregate, read-only) ────────────

  /**
   * GET /api/admin/users/:id/access — composed per-user access view for the
   * unified permission modal. Aggregates feature flags, platform capabilities/
   * entity policies, and tool grants into feature points. Writes still go to the
   * granular endpoints (features / platform overrides / entity-policies / tools).
   */
  .get('/users/:id/access', async (c) => {
    const id = c.req.param('id');
    const user = await getDb().users.getById(id);
    if (!user) return c.json({ error: 'User not found' }, 404);
    return c.json(await buildUserAccessView(getDb(), user));
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

    // Feature-owned tools (CRM/Knowledge/Projects/Cloud Agent) ride with their feature
    // point's main toggle, and always-on tools need no grant at all — neither is
    // assignable individually, or the assignment would bypass (or fake) the feature.
    const featureOwned = body.tools.filter((t) => FEATURE_OWNED_TOOL_IDS.has(t));
    if (featureOwned.length > 0) {
      return c.json(
        {
          error: `Feature-owned tools are granted via their feature, not assigned directly: ${featureOwned.join(', ')}`,
        },
        400,
      );
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
    if (!user) return c.json({ error: 'User not found' }, 404);

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
        nickname: userMap.get(row.user_id)?.nickname ?? 'Unknown',
        role: userMap.get(row.user_id)?.role ?? 'unknown',
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
