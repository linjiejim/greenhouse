/**
 * API 客户端管理端点 — /api/admin/clients
 *
 * POST   /api/admin/clients                 — 创建 API 客户端（返回一次性明文 Key）
 * GET    /api/admin/clients                 — 列出所有客户端
 * GET    /api/admin/clients/:id             — 客户端详情
 * PUT    /api/admin/clients/:id             — 更新配置（状态/限额/允许 profiles）
 * POST   /api/admin/clients/:id/rotate-key  — 轮换 API Key
 * DELETE /api/admin/clients/:id             — 删除客户端
 * GET    /api/admin/clients/:id/usage       — 查询用量统计
 * GET    /api/admin/clients/:id/audit       — 查询审计日志
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import type { ApiClientRow, ApiClientChannel } from '@greenhouse/db';
import { getAuthUser } from '../auth/middleware.js';
import { generateApiKey } from '../auth/api-key.js';
import { listProfileIds } from '../profile.js';
import { safeJsonParse } from '@greenhouse/utils/json';
import type { AppEnv } from '../app-env.js';

const clientRoutes = new Hono<AppEnv>()
  // ─── POST /api/admin/clients — 创建 API 客户端 ──────────
  .post('/', async (c) => {
    const currentUser = getAuthUser(c);
    const body = (await c.req.json()) as {
      app_id?: string;
      app_name?: string;
      allowed_profiles?: string[];
      rate_limit_rpm?: number;
      rate_limit_rpd?: number;
      daily_token_limit?: number;
      user_id?: string;
      channel?: ApiClientChannel;
      meta?: Record<string, unknown>;
    };

    if (!body.app_id || !body.app_name) {
      return c.json({ error: 'app_id and app_name are required' }, 400);
    }

    // Validate app_id format (lowercase slug)
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(body.app_id) || body.app_id.length > 64) {
      return c.json({ error: 'app_id must be a lowercase slug (a-z, 0-9, hyphens, 2-64 chars)' }, 400);
    }

    // Check duplicate
    const existing = await getDb().apiClients.getByAppId(body.app_id);
    if (existing) {
      return c.json({ error: `API client "${body.app_id}" already exists` }, 409);
    }

    // Validate allowed_profiles
    if (body.allowed_profiles) {
      const available = new Set(listProfileIds());
      const invalid = body.allowed_profiles.filter((p) => !available.has(p));
      if (invalid.length > 0) {
        return c.json({ error: `Unknown profiles: ${invalid.join(', ')}` }, 400);
      }
    }

    // Validate channel (defaults to 'api' in the service).
    const VALID_CHANNELS: ReadonlySet<ApiClientChannel> = new Set(['api', 'a2a', 'local-agent', 'cli', 'relay']);
    if (body.channel && !VALID_CHANNELS.has(body.channel)) {
      return c.json({ error: `Unknown channel: ${body.channel}` }, 400);
    }

    // When the key is bound to an internal user, validate that user up front so a
    // bound key is never created pointing at a missing/external/disabled account.
    // This is required for the MCP surface (channel 'a2a'), which rejects keys
    // not bound to an active internal user at request time anyway.
    if (body.user_id) {
      const boundUser = await getDb().users.getById(body.user_id);
      if (!boundUser) {
        return c.json({ error: `Bound user "${body.user_id}" not found` }, 400);
      }
      if (boundUser.status !== 'active') {
        return c.json({ error: 'Bound user is not active' }, 400);
      }
      if (boundUser.role !== 'super' && boundUser.role !== 'team') {
        return c.json({ error: 'Bound user must be internal (super or team)' }, 400);
      }
    }

    // Generate API key
    const { raw, hash } = generateApiKey();

    const client = await getDb().apiClients.create({
      app_id: body.app_id,
      app_name: body.app_name,
      api_key_hash: hash,
      allowed_profiles: body.allowed_profiles,
      rate_limit_rpm: body.rate_limit_rpm,
      rate_limit_rpd: body.rate_limit_rpd,
      daily_token_limit: body.daily_token_limit,
      user_id: body.user_id,
      channel: body.channel,
      meta: body.meta,
      created_by: currentUser.id,
    });

    return c.json(
      {
        client: formatClient(client),
        api_key: raw, // ⚠️ 仅此一次返回明文 Key
        warning: 'Save the api_key now — it will not be shown again.',
      },
      201,
    );
  })
  // ─── GET /api/admin/clients — 列出所有客户端 ──────────────
  .get('/', async (c) => {
    const clients = await getDb().apiClients.list();

    return c.json({
      clients: clients.map(formatClient),
    });
  })
  // ─── GET /api/admin/clients/:id — 客户端详情 ──────────────
  .get('/:id', async (c) => {
    const id = c.req.param('id');
    const client = await getDb().apiClients.getById(id);
    if (!client) return c.json({ error: 'Client not found' }, 404);

    // Get today's usage
    let todayTokens = 0;
    let totalRequests = 0;
    try {
      todayTokens = await getDb().apiAudit.getDailyTokenUsage(client.app_id);
      totalRequests = await getDb().apiAudit.count({ app_id: client.app_id });
    } catch {
      /* ignore */
    }

    return c.json({
      client: formatClient(client),
      usage: {
        today_tokens: todayTokens,
        daily_token_limit: client.daily_token_limit,
        total_requests: totalRequests,
      },
    });
  })
  // ─── PUT /api/admin/clients/:id — 更新配置 ────────────────
  .put('/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as {
      app_name?: string;
      status?: 'active' | 'disabled';
      allowed_profiles?: string[];
      rate_limit_rpm?: number;
      rate_limit_rpd?: number;
      daily_token_limit?: number;
    };

    const client = await getDb().apiClients.getById(id);
    if (!client) return c.json({ error: 'Client not found' }, 404);

    // Validate profiles if provided
    if (body.allowed_profiles) {
      const available = new Set(listProfileIds());
      const invalid = body.allowed_profiles.filter((p) => !available.has(p));
      if (invalid.length > 0) {
        return c.json({ error: `Unknown profiles: ${invalid.join(', ')}` }, 400);
      }
    }

    const updated = await getDb().apiClients.update(id, body);
    if (!updated) return c.json({ error: 'Client not found' }, 404);

    return c.json({ client: formatClient(updated) });
  })
  // ─── POST /api/admin/clients/:id/rotate-key — 轮换 Key ──
  .post('/:id/rotate-key', async (c) => {
    const id = c.req.param('id');

    const client = await getDb().apiClients.getById(id);
    if (!client) return c.json({ error: 'Client not found' }, 404);

    const { raw, hash } = generateApiKey();
    await getDb().apiClients.update(id, { api_key_hash: hash });

    return c.json({
      api_key: raw,
      warning: 'Save the new api_key now — it will not be shown again. The old key is now invalid.',
    });
  })
  // ─── DELETE /api/admin/clients/:id — 删除客户端 ──────────
  .delete('/:id', async (c) => {
    const id = c.req.param('id');

    const client = await getDb().apiClients.getById(id);
    if (!client) return c.json({ error: 'Client not found' }, 404);

    await getDb().apiClients.delete(id);
    return c.json({ ok: true, deleted: client.app_id });
  })
  // ─── GET /api/admin/clients/:id/usage — 用量统计 ─────────
  .get('/:id/usage', async (c) => {
    const id = c.req.param('id');
    const since = c.req.query('since') || undefined;

    const client = await getDb().apiClients.getById(id);
    if (!client) return c.json({ error: 'Client not found' }, 404);

    const todayTokens = await getDb().apiAudit.getDailyTokenUsage(client.app_id);
    const totalRequests = await getDb().apiAudit.count({
      app_id: client.app_id,
      since,
    });

    // Get recent audit records for detailed stats
    const recent = await getDb().apiAudit.list({
      app_id: client.app_id,
      since,
      limit: 100,
    });

    // Aggregate from audit records
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalDurationMs = 0;
    let successCount = 0;
    let errorCount = 0;

    for (const r of recent) {
      totalInputTokens += r.input_tokens ?? 0;
      totalOutputTokens += r.output_tokens ?? 0;
      totalDurationMs += r.duration_ms ?? 0;
      if (r.status_code === 200) successCount++;
      else if (r.error) errorCount++;
    }

    return c.json({
      app_id: client.app_id,
      today_tokens: todayTokens,
      daily_token_limit: client.daily_token_limit,
      period: {
        total_requests: totalRequests,
        success: successCount,
        errors: errorCount,
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
        total_duration_ms: totalDurationMs,
      },
    });
  })
  // ─── GET /api/admin/clients/:id/audit — 审计日志 ─────────
  .get('/:id/audit', async (c) => {
    const id = c.req.param('id');

    const client = await getDb().apiClients.getById(id);
    if (!client) return c.json({ error: 'Client not found' }, 404);

    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200);
    const offset = parseInt(c.req.query('offset') || '0', 10);
    const since = c.req.query('since') || undefined;
    const extUserId = c.req.query('ext_user_id') || undefined;

    const records = await getDb().apiAudit.list({
      app_id: client.app_id,
      ext_user_id: extUserId,
      since,
      limit,
      offset,
    });

    const total = await getDb().apiAudit.count({ app_id: client.app_id, since });

    return c.json({
      records: records.map((r) => ({
        ...r,
        meta: safeJsonParse(r.meta),
      })),
      total,
      has_more: offset + limit < total,
    });
  });

// ─── Helpers ─────────────────────────────────────────────

function formatClient(client: ApiClientRow) {
  return {
    id: client.id,
    app_id: client.app_id,
    app_name: client.app_name,
    status: client.status,
    channel: client.channel,
    user_id: client.user_id,
    allowed_profiles: safeJsonParse(client.allowed_profiles),
    rate_limit_rpm: client.rate_limit_rpm,
    rate_limit_rpd: client.rate_limit_rpd,
    daily_token_limit: client.daily_token_limit,
    meta: safeJsonParse(client.meta),
    created_by: client.created_by,
    created_at: client.created_at,
    updated_at: client.updated_at,
  };
}

export default clientRoutes;
