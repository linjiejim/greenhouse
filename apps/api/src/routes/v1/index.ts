/**
 * 外部 API v1 路由组装 — /api/v1
 *
 * 所有 v1 端点共享 API Key 认证中间件和独立限流。
 * 与内部 /api/chat 完全隔离。
 */

import { Hono } from 'hono';
import { logger } from '@greenhouse/utils/logger';
import type { Context, Next } from 'hono';
import { apiKeyMiddleware, getApiClient, createPerKeyRateLimitMiddleware } from '../../auth/api-key.js';
import { createV1ChatRoute } from './chat.js';
import sessions from './sessions.js';
import type { ToolRegistry } from '../../agent.js';
import type { AppEnv } from '../../app-env.js';

// ─── Per API-Key Rate Limiter (shared factory; same policy as /api/agent) ───

const v1RateLimitMiddleware = createPerKeyRateLimitMiddleware('v1');

// ─── Request Logging ─────────────────────────────────────

async function v1LoggingMiddleware(c: Context, next: Next) {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  // Get app_id if available (after auth middleware)
  let appId = 'unknown';
  try {
    appId = getApiClient(c).app_id;
  } catch {
    /* pre-auth */
  }

  logger.info(`[V1-API] → ${method} ${path} [${appId}]`);

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;
  const icon = status >= 400 ? '❌' : '✅';
  logger.info(`[V1-API] ← ${icon} ${method} ${path} ${status} (${duration}ms) [${appId}]`);
}

// ─── Route Assembly ──────────────────────────────────────

export function createV1Routes(toolRegistry: ToolRegistry) {
  // Mount routes
  const chatRoute = createV1ChatRoute(toolRegistry);

  const v1 = new Hono<AppEnv>()
    // Auth: API Key required for all v1 endpoints
    .use('*', apiKeyMiddleware)
    // Logging (after auth so we have app_id)
    .use('*', v1LoggingMiddleware)
    // Rate limiting (after auth so we have client config)
    .use('*', v1RateLimitMiddleware)
    .route('/chat/completions', chatRoute)
    .route('/sessions', sessions);

  return v1;
}
