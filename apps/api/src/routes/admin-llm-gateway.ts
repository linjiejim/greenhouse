/**
 * 团队网关管理端点 — /api/admin/llm-gateway （仅 super）
 *
 * 上游池 (llm_upstreams):
 *   GET    /upstreams           列出（不含明文 key）
 *   POST   /upstreams           新建 {name, provider_kind, base_url, api_key}
 *   PUT    /upstreams/:id        更新（api_key 可选，提供则重新加密）
 *   DELETE /upstreams/:id        删除（级联删除其模型）
 *
 * 模型目录 (llm_gateway_models):
 *   GET    /models              列出
 *   POST   /models              新建
 *   PUT    /models/:id           更新
 *   DELETE /models/:id           删除
 *
 * 中转 key 治理（复用 api_clients, channel='relay'）:
 *   GET    /keys                列出全部网关 key + 今日用量
 *   PUT    /keys/:id             改状态/限额/可用模型子集（吊销=status:'disabled'）
 *   DELETE /keys/:id             删除
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import type { ApiClientRow, LlmUpstreamKind, LlmUpstreamRow, LlmGatewayModelRow } from '@greenhouse/db';
import { getAuthUser } from '../auth/middleware.js';
import { encryptToken, isEncryptionConfigured } from '../auth/crypto.js';
import { safeJsonParse } from '@greenhouse/utils/json';
import type { AppEnv } from '../app-env.js';

const UPSTREAM_KINDS: ReadonlySet<LlmUpstreamKind> = new Set<LlmUpstreamKind>([
  'openai',
  'anthropic',
  'deepseek',
  'openai-compatible',
]);

function upstreamView(u: LlmUpstreamRow) {
  return {
    id: u.id,
    name: u.name,
    provider_kind: u.provider_kind,
    base_url: u.base_url,
    has_key: !!u.api_key_enc,
    enabled: u.enabled,
    created_by: u.created_by,
    created_at: u.created_at,
    updated_at: u.updated_at,
  };
}

function modelView(m: LlmGatewayModelRow) {
  return { ...m };
}

function relayKeyAdminView(k: ApiClientRow) {
  const meta = safeJsonParse(k.meta, {}) as { allowed_models?: string[]; auto?: boolean };
  return {
    id: k.id,
    app_id: k.app_id,
    name: k.app_name,
    status: k.status,
    user_id: k.user_id,
    auto: meta.auto === true,
    allowed_models: Array.isArray(meta.allowed_models) ? meta.allowed_models : null,
    rate_limit_rpm: k.rate_limit_rpm,
    rate_limit_rpd: k.rate_limit_rpd,
    daily_token_limit: k.daily_token_limit,
    created_at: k.created_at,
    updated_at: k.updated_at,
  };
}

const adminGatewayRoutes = new Hono<AppEnv>()
  // ════════════════ Upstreams ════════════════
  .get('/upstreams', async (c) => {
    const rows = await getDb().llmUpstreams.list();
    return c.json({ upstreams: rows.map(upstreamView) });
  })
  .post('/upstreams', async (c) => {
    const user = getAuthUser(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      provider_kind?: string;
      base_url?: string;
      api_key?: string;
      enabled?: boolean;
    };

    if (!body.name || !body.provider_kind || !body.base_url || !body.api_key) {
      return c.json({ error: 'name, provider_kind, base_url and api_key are required' }, 400);
    }
    if (!UPSTREAM_KINDS.has(body.provider_kind as LlmUpstreamKind)) {
      return c.json({ error: `provider_kind must be one of: ${[...UPSTREAM_KINDS].join(', ')}` }, 400);
    }
    if (!isEncryptionConfigured()) {
      return c.json({ error: 'PROVIDER_TOKEN_ENCRYPTION_KEY is not configured' }, 503);
    }

    const created = await getDb().llmUpstreams.create({
      name: body.name,
      provider_kind: body.provider_kind as LlmUpstreamKind,
      base_url: body.base_url,
      api_key_enc: encryptToken(body.api_key),
      enabled: body.enabled ?? true,
      created_by: user.id,
    });
    return c.json({ upstream: upstreamView(created) }, 201);
  })
  .put('/upstreams/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      provider_kind?: string;
      base_url?: string;
      api_key?: string;
      enabled?: boolean;
    };

    const existing = await getDb().llmUpstreams.getById(id);
    if (!existing) return c.json({ error: 'Upstream not found' }, 404);
    if (body.provider_kind !== undefined && !UPSTREAM_KINDS.has(body.provider_kind as LlmUpstreamKind)) {
      return c.json({ error: `provider_kind must be one of: ${[...UPSTREAM_KINDS].join(', ')}` }, 400);
    }
    if (body.api_key !== undefined && !isEncryptionConfigured()) {
      return c.json({ error: 'PROVIDER_TOKEN_ENCRYPTION_KEY is not configured' }, 503);
    }

    const updated = await getDb().llmUpstreams.update(id, {
      name: body.name,
      provider_kind: body.provider_kind as LlmUpstreamKind | undefined,
      base_url: body.base_url,
      api_key_enc: body.api_key !== undefined ? encryptToken(body.api_key) : undefined,
      enabled: body.enabled,
    });
    return c.json({ upstream: updated ? upstreamView(updated) : null });
  })
  .delete('/upstreams/:id', async (c) => {
    const id = c.req.param('id');
    const deleted = await getDb().llmUpstreams.delete(id);
    return c.json({ ok: true, deleted });
  })
  // ════════════════ Models ════════════════
  .get('/models', async (c) => {
    const rows = await getDb().llmGatewayModels.list();
    return c.json({ models: rows.map(modelView) });
  })
  .post('/models', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      public_id?: string;
      display_name?: string;
      upstream_id?: string;
      upstream_model?: string;
      enabled?: boolean;
      is_default?: boolean;
      is_public?: boolean;
      sort_order?: number;
    };

    if (!body.public_id || !body.display_name || !body.upstream_id || !body.upstream_model) {
      return c.json({ error: 'public_id, display_name, upstream_id and upstream_model are required' }, 400);
    }
    if (!/^[A-Za-z0-9._-]+$/.test(body.public_id)) {
      return c.json({ error: 'public_id may only contain letters, digits, dot, underscore and hyphen' }, 400);
    }
    const upstream = await getDb().llmUpstreams.getById(body.upstream_id);
    if (!upstream) return c.json({ error: 'upstream_id does not exist' }, 400);
    const dup = await getDb().llmGatewayModels.getByPublicId(body.public_id);
    if (dup) return c.json({ error: `Model "${body.public_id}" already exists` }, 409);

    const created = await getDb().llmGatewayModels.create({
      public_id: body.public_id,
      display_name: body.display_name,
      upstream_id: body.upstream_id,
      upstream_model: body.upstream_model,
      enabled: body.enabled,
      is_default: body.is_default,
      is_public: body.is_public,
      sort_order: body.sort_order,
    });
    if (created.is_default) await getDb().llmGatewayModels.clearDefaultExcept(created.id);
    return c.json({ model: modelView(created) }, 201);
  })
  .put('/models/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      display_name?: string;
      upstream_id?: string;
      upstream_model?: string;
      enabled?: boolean;
      is_default?: boolean;
      is_public?: boolean;
      sort_order?: number;
    };

    const existing = await getDb().llmGatewayModels.getById(id);
    if (!existing) return c.json({ error: 'Model not found' }, 404);
    if (body.upstream_id !== undefined) {
      const upstream = await getDb().llmUpstreams.getById(body.upstream_id);
      if (!upstream) return c.json({ error: 'upstream_id does not exist' }, 400);
    }

    const updated = await getDb().llmGatewayModels.update(id, body);
    if (updated?.is_default) await getDb().llmGatewayModels.clearDefaultExcept(updated.id);
    return c.json({ model: updated ? modelView(updated) : null });
  })
  .delete('/models/:id', async (c) => {
    const id = c.req.param('id');
    const deleted = await getDb().llmGatewayModels.delete(id);
    return c.json({ ok: true, deleted });
  })
  // ════════════════ Relay keys ════════════════
  .get('/keys', async (c) => {
    const all = (await getDb().apiClients.list()).filter((k) => k.channel === 'relay');
    const withUsage = await Promise.all(
      all.map(async (k) => {
        let today_tokens = 0;
        try {
          today_tokens = await getDb().apiAudit.getDailyTokenUsage(k.app_id);
        } catch {
          /* ignore */
        }
        return { ...relayKeyAdminView(k), today_tokens };
      }),
    );
    return c.json({ keys: withUsage });
  })
  .put('/keys/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      status?: 'active' | 'disabled';
      daily_token_limit?: number;
      rate_limit_rpm?: number;
      rate_limit_rpd?: number;
      allowed_models?: string[] | null;
    };

    const client = await getDb().apiClients.getById(id);
    if (!client || client.channel !== 'relay') return c.json({ error: 'Gateway key not found' }, 404);

    // Merge allowed_models into existing meta when provided.
    let meta: Record<string, unknown> | undefined;
    if (body.allowed_models !== undefined) {
      const current = safeJsonParse(client.meta, {}) as Record<string, unknown>;
      meta = { ...current };
      if (body.allowed_models === null) delete meta.allowed_models;
      else meta.allowed_models = body.allowed_models;
    }

    const updated = await getDb().apiClients.update(id, {
      status: body.status,
      daily_token_limit: body.daily_token_limit,
      rate_limit_rpm: body.rate_limit_rpm,
      rate_limit_rpd: body.rate_limit_rpd,
      meta,
    });
    return c.json({ key: updated ? relayKeyAdminView(updated) : null });
  })
  .delete('/keys/:id', async (c) => {
    const id = c.req.param('id');
    const client = await getDb().apiClients.getById(id);
    if (!client || client.channel !== 'relay') return c.json({ error: 'Gateway key not found' }, 404);
    await getDb().apiClients.delete(id);
    return c.json({ ok: true, deleted: client.app_id });
  });

export default adminGatewayRoutes;
