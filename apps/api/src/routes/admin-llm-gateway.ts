/**
 * 团队网关管理端点 — /api/admin/llm-gateway （仅 super）
 *
 * 模型目录 (只读):
 *   GET    /catalog             config/models.yaml 的模型清单 + 每条 provider 链的 env 就绪状态
 *
 * 中转 key 治理（复用 api_clients, channel='relay'）:
 *   GET    /keys                列出全部网关 key + 今日用量
 *   PUT    /keys/:id             改状态/限额/可用模型子集（吊销=status:'disabled'）
 *   DELETE /keys/:id             删除
 *
 * 模型目录不再可写：模型与 provider 链声明在 `config/models.yaml`，密钥在 env。
 * 这里只回报"配了什么、通不通"，绝不回显密钥本身。Key 治理留在后台是因为它是
 * 授权而非配置——谁能用、用多少，是运行期决定。
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import type { ApiClientRow } from '@greenhouse/db';
import { getAuthUser } from '../auth/middleware.js';
import { safeJsonParse } from '@greenhouse/utils/json';
import { getModelCatalog } from '../config/models.js';
import { isPassthroughKind, resolveRelayModel } from '../llm/relay-proxy.js';
import type { AppEnv } from '../app-env.js';

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
  // ════════════════ Model catalog (read-only) ════════════════
  .get('/catalog', async (c) => {
    getAuthUser(c); // super-gated at the mount point
    const catalog = getModelCatalog();
    const models = Object.entries(catalog.models).map(([id, entry]) => ({
      id,
      name: entry.name,
      is_default: catalog.relay.default === id,
      is_public: catalog.relay.public.includes(id),
      /** True when at least one provider in the chain is usable right now. */
      ready: resolveRelayModel(id, entry) !== null,
      providers: entry.providers.map((p) => ({
        provider: p.provider,
        model: p.model,
        base_url: p.baseUrl ?? null,
        api_key_env: p.apiKeyEnv,
        // Presence only — the value never leaves the server.
        api_key_configured: Boolean(process.env[p.apiKeyEnv]),
        relay_capable: isPassthroughKind(p.provider),
      })),
    }));
    return c.json({ models, source: 'config/models.yaml' });
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
