/**
 * 团队网关 Key 自助管理端点 — /api/auth/llm-keys
 *
 * GET    /api/auth/llm-keys           — 列出自己的网关 key
 * GET    /api/auth/llm-keys/catalog   — 当前可选的网关模型目录（用于挑选子集）
 * POST   /api/auth/llm-keys           — 创建网关 key（绑定可用模型子集，明文只返回一次）
 * DELETE /api/auth/llm-keys/:id       — 吊销自己的网关 key
 *
 * 认证：Bearer Token（内部用户）。所有内部用户可自助管理。
 * 网关 key 复用 api_clients（channel='relay'），可用模型子集存 meta.allowed_models；
 * 历史自动签发 key 的 meta.auto 标记仍会原样返回，便于管理员识别和回收。
 */

import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { getAuthUser } from '../auth/middleware.js';
import { generateApiKey } from '../auth/api-key.js';
import { getDb } from '@greenhouse/db';
import type { ApiClientRow } from '@greenhouse/db';
import { safeJsonParse } from '@greenhouse/utils/json';
import { resolveRelayModel } from '../llm/relay-proxy.js';
import { getModelCatalog } from '../config/models.js';
import type { AppEnv } from '../app-env.js';

const MAX_RELAY_KEYS_PER_USER = 10;
/** Generous org-wide default; admins can lower it per key via /api/admin/llm-gateway. */
export const DEFAULT_RELAY_DAILY_TOKEN_LIMIT = 50_000_000;
const DEFAULT_RELAY_RPM = 60;
const DEFAULT_RELAY_RPD = 10_000;

function relayKeyView(k: ApiClientRow) {
  const meta = safeJsonParse(k.meta, {}) as { allowed_models?: string[]; auto?: boolean };
  return {
    id: k.id,
    name: k.app_name,
    app_id: k.app_id,
    status: k.status,
    auto: meta.auto === true,
    allowed_models: Array.isArray(meta.allowed_models) ? meta.allowed_models : null,
    rate_limit_rpm: k.rate_limit_rpm,
    rate_limit_rpd: k.rate_limit_rpd,
    daily_token_limit: k.daily_token_limit,
    created_at: k.created_at,
    updated_at: k.updated_at,
  };
}

/**
 * Catalog models that can actually be served right now: declared in
 * `config/models.yaml`, OpenAI-compatible protocol, and with their API key
 * present in env. A model nobody can reach must not be offerable on a key.
 */
function relayReadyModels() {
  const catalog = getModelCatalog();
  return Object.entries(catalog.models)
    .map(([id, entry]) => resolveRelayModel(id, entry))
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .map((m) => ({ ...m, isPublic: catalog.relay.public.includes(m.id), isDefault: catalog.relay.default === m.id }));
}

const llmKeyRoutes = new Hono<AppEnv>()
  // ─── GET /catalog — 可选模型目录 ──────────────────────────
  .get('/catalog', async (c) => {
    return c.json({
      models: relayReadyModels().map((m) => ({
        public_id: m.id,
        display_name: m.displayName,
        is_default: m.isDefault,
        is_public: m.isPublic,
      })),
    });
  })
  // ─── GET / — 列出自己的网关 key ────────────────────────────
  .get('/', async (c) => {
    const user = getAuthUser(c);
    const keys = (await getDb().apiClients.listByUserId(user.id)).filter((k) => k.channel === 'relay');
    return c.json({ keys: keys.map(relayKeyView), limit: MAX_RELAY_KEYS_PER_USER, count: keys.length });
  })
  // ─── POST / — 创建网关 key ─────────────────────────────────
  .post('/', async (c) => {
    const user = getAuthUser(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      allowed_models?: string[];
    };

    const existing = (await getDb().apiClients.listByUserId(user.id)).filter((k) => k.channel === 'relay');
    if (existing.length >= MAX_RELAY_KEYS_PER_USER) {
      return c.json(
        { error: `Maximum ${MAX_RELAY_KEYS_PER_USER} gateway keys per user. Delete unused keys first.` },
        400,
      );
    }

    // Validate requested model subset against the enabled catalog.
    let allowedModels: string[] | undefined;
    if (Array.isArray(body.allowed_models) && body.allowed_models.length > 0) {
      const available = new Set(relayReadyModels().map((m) => m.id));
      const invalid = body.allowed_models.filter((m) => !available.has(m));
      if (invalid.length > 0) {
        return c.json({ error: `Unknown or disabled models: ${invalid.join(', ')}` }, 400);
      }
      allowedModels = body.allowed_models;
    }

    const suffix = randomBytes(4).toString('hex');
    const appId = `relay-${user.id.slice(0, 8)}-${suffix}`;
    const { raw, hash } = generateApiKey();

    const client = await getDb().apiClients.create({
      app_id: appId,
      app_name: body.name?.trim() || 'Gateway Key',
      api_key_hash: hash,
      rate_limit_rpm: DEFAULT_RELAY_RPM,
      rate_limit_rpd: DEFAULT_RELAY_RPD,
      daily_token_limit: DEFAULT_RELAY_DAILY_TOKEN_LIMIT,
      user_id: user.id,
      channel: 'relay',
      created_by: user.id,
      meta: allowedModels ? { allowed_models: allowedModels } : {},
    });

    return c.json(
      {
        key: relayKeyView(client),
        api_key: raw,
        warning: 'Save the api_key now — it will not be shown again.',
      },
      201,
    );
  })
  // ─── DELETE /:id — 吊销自己的网关 key ──────────────────────
  .delete('/:id', async (c) => {
    const user = getAuthUser(c);
    const id = c.req.param('id');

    const client = await getDb().apiClients.getById(id);
    if (!client) return c.json({ error: 'Key not found' }, 404);
    if (client.user_id !== user.id && user.role !== 'super') {
      return c.json({ error: 'Not authorized to delete this key' }, 403);
    }
    if (client.channel !== 'relay') {
      return c.json({ error: 'This is not a gateway key' }, 400);
    }

    await getDb().apiClients.delete(id);
    return c.json({ ok: true, deleted: client.app_id });
  });

export default llmKeyRoutes;
