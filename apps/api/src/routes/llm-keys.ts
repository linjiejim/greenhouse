/**
 * 团队网关 Key 自助管理端点 — /api/auth/llm-keys
 *
 * GET    /api/auth/llm-keys           — 列出自己的网关 key
 * GET    /api/auth/llm-keys/catalog   — 当前可选的网关模型目录（用于挑选子集）
 * POST   /api/auth/llm-keys           — 创建网关 key（绑定可用模型子集，明文只返回一次）
 * POST   /api/auth/llm-keys/provision — 无感自动签发：取得/轮换默认 key（Desktop 用）
 * DELETE /api/auth/llm-keys/:id       — 吊销自己的网关 key
 *
 * 认证：Bearer Token（内部用户）。所有内部用户可自助管理。
 * 网关 key 复用 api_clients（channel='relay'），可用模型子集存 meta.allowed_models；
 * 自动签发的默认 key 标记 meta.auto=true 且不限定子集（始终跟随 is_public 目录）。
 */

import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { getAuthUser } from '../auth/middleware.js';
import { generateApiKey } from '../auth/api-key.js';
import { getDb } from '@greenhouse/db';
import type { ApiClientRow } from '@greenhouse/db';
import { safeJsonParse } from '@greenhouse/utils/json';
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

/** Enabled public_ids the user may bind a key to. */
async function enabledPublicIds(): Promise<Set<string>> {
  const enabled = await getDb().llmGatewayModels.listEnabled();
  return new Set(enabled.map((m) => m.public_id));
}

const llmKeyRoutes = new Hono<AppEnv>()
  // ─── GET /catalog — 可选模型目录 ──────────────────────────
  .get('/catalog', async (c) => {
    const enabled = await getDb().llmGatewayModels.listEnabled();
    return c.json({
      models: enabled.map((m) => ({
        public_id: m.public_id,
        display_name: m.display_name,
        is_default: m.is_default,
        is_public: m.is_public,
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
      const available = await enabledPublicIds();
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
  // ─── POST /provision — 无感自动签发（取得或轮换默认 key）─────
  .post('/provision', async (c) => {
    const user = getAuthUser(c);
    const keys = (await getDb().apiClients.listByUserId(user.id)).filter((k) => k.channel === 'relay');
    const auto = keys.find((k) => (safeJsonParse(k.meta, {}) as { auto?: boolean }).auto === true);

    const { raw, hash } = generateApiKey();

    // Rotate the existing auto key (its old raw was only shown once / may be lost), or create a new one.
    // This caps each user at a single seamless key while always returning a usable secret.
    let client: ApiClientRow | undefined;
    if (auto) {
      client = await getDb().apiClients.update(auto.id, { api_key_hash: hash, status: 'active' });
    } else {
      const suffix = randomBytes(4).toString('hex');
      client = await getDb().apiClients.create({
        app_id: `relay-${user.id.slice(0, 8)}-${suffix}`,
        app_name: 'Desktop Gateway',
        api_key_hash: hash,
        rate_limit_rpm: DEFAULT_RELAY_RPM,
        rate_limit_rpd: DEFAULT_RELAY_RPD,
        daily_token_limit: DEFAULT_RELAY_DAILY_TOKEN_LIMIT,
        user_id: user.id,
        channel: 'relay',
        created_by: user.id,
        meta: { auto: true },
      });
    }

    if (!client) return c.json({ error: 'Failed to provision gateway key' }, 500);
    return c.json({ key: relayKeyView(client), api_key: raw });
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
