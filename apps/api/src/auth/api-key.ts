/**
 * API Key authentication — 外部服务的 Server-to-Server 认证。
 *
 * API Key 格式：gh_sk_<32字节hex>
 * 数据库存储 SHA-256 哈希，原始 Key 仅在创建时返回一次。
 *
 * 中间件从 Authorization: Bearer header 提取并验证，将 ApiClient 注入 Hono context。
 */

import { createHash, randomBytes } from 'node:crypto';
import { logger } from '@greenhouse/utils/logger';
import type { Context, Next } from 'hono';
import { getDb } from '@greenhouse/db';
import type { ApiClientRow } from '@greenhouse/db';
import { InMemoryRateLimiter } from '../security.js';

// ─── Constants ───────────────────────────────────────────

const API_KEY_PREFIX = 'gh_sk_';
const API_KEY_BYTES = 32;

// ─── Key Generation ──────────────────────────────────────

/**
 * Generate a new API key and its SHA-256 hash.
 * @returns { raw, hash } — raw is shown once to admin, hash is stored.
 */
export function generateApiKey(): { raw: string; hash: string } {
  const raw = API_KEY_PREFIX + randomBytes(API_KEY_BYTES).toString('hex');
  const hash = hashApiKey(raw);
  return { raw, hash };
}

/**
 * Hash an API key for storage/lookup.
 */
export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Validate API key format (quick check before DB lookup).
 */
export function isValidApiKeyFormat(key: string): boolean {
  return key.startsWith(API_KEY_PREFIX) && key.length === API_KEY_PREFIX.length + API_KEY_BYTES * 2;
}

// ─── Context Helpers ─────────────────────────────────────

/**
 * Get the authenticated API client from Hono context.
 * Throws if called outside apiKeyMiddleware.
 */
export function getApiClient(c: Context): ApiClientRow {
  const client = c.get('apiClient') as ApiClientRow | undefined;
  if (!client) throw new Error('getApiClient called without apiKeyMiddleware');
  return client;
}

/**
 * Get the client IP address from the request.
 */
export function getClientIP(c: Context): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown';
}

// ─── Middleware ───────────────────────────────────────────

/**
 * API Key authentication middleware for external v1 endpoints.
 * Validates Authorization: Bearer header, checks client status, injects into context.
 */
export async function apiKeyMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json(
      {
        error: {
          message: 'Missing or invalid Authorization header. Use: Authorization: Bearer <api_key>',
          type: 'auth_error',
        },
      },
      401,
    );
  }

  const apiKey = authHeader.slice(7); // Remove "Bearer "

  if (!isValidApiKeyFormat(apiKey)) {
    return c.json({ error: { message: 'Invalid API key format', type: 'auth_error' } }, 401);
  }

  const hash = hashApiKey(apiKey);

  let client: ApiClientRow | undefined;
  try {
    client = await getDb().apiClients.getByKeyHash(hash);
  } catch (err) {
    logger.error('[api-key] DB lookup failed:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }

  if (!client) {
    return c.json({ error: { message: 'Invalid API key', type: 'auth_error' } }, 401);
  }

  if (client.status !== 'active') {
    return c.json({ error: { message: 'API client is disabled', type: 'auth_error' } }, 403);
  }

  // Inject client into context
  c.set('apiClient', client);

  return next();
}

// ─── Per-key rate limiting ────────────────────────────────

/**
 * Build a per-API-key rate-limit middleware (RPM + RPD from the client's own
 * limits). Shared by all API-key surfaces (v1, agent) so the policy never forks.
 * Must run after a middleware that sets `apiClient` in context.
 *
 * @param prefix - namespace for the limiter keys (e.g. 'v1', 'agent')
 */
export function createPerKeyRateLimitMiddleware(prefix: string) {
  const limiter = new InMemoryRateLimiter(120_000);
  return async function perKeyRateLimit(c: Context, next: Next) {
    const client = getApiClient(c);
    const appId = client.app_id;

    const rpm = limiter.check(`${prefix}:rpm:${appId}`, 60_000, client.rate_limit_rpm);
    c.header('X-RateLimit-Limit', String(client.rate_limit_rpm));
    c.header('X-RateLimit-Remaining', String(Math.max(0, rpm.remaining)));
    c.header('X-RateLimit-Reset', String(Math.ceil(rpm.resetAt / 1000)));
    if (!rpm.allowed) {
      return c.json({ error: { message: 'Rate limit exceeded (requests per minute)', type: 'rate_limit_error' } }, 429);
    }

    const rpd = limiter.check(`${prefix}:rpd:${appId}`, 86_400_000, client.rate_limit_rpd);
    if (!rpd.allowed) {
      return c.json({ error: { message: 'Rate limit exceeded (requests per day)', type: 'rate_limit_error' } }, 429);
    }

    return next();
  };
}
