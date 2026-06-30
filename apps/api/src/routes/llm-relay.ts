/**
 * LLM Gateway 中转端点 — /api/llm
 *
 * GET  /api/llm/v1/models             — 当前 key 可用的模型目录（OpenAI 兼容）
 * POST /api/llm/v1/chat/completions   — 统一 OpenAI 兼容入口，按 model 解析上游并转发
 *
 * 认证：Authorization: Bearer <relay api_key>（channel='relay'，复用 apiKeyMiddleware）
 * 限流：per-key RPM/RPD + 每日 token 配额
 * 审计：每次调用写入 api_audit_log（绑定内部用户）
 */

import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { logger } from '@greenhouse/utils/logger';
import { getDb } from '@greenhouse/db';
import type { ApiClientRow, LlmGatewayModelRow } from '@greenhouse/db';
import { apiKeyMiddleware, getApiClient, getClientIP, createPerKeyRateLimitMiddleware } from '../auth/api-key.js';
import { decryptToken, isEncryptionConfigured } from '../auth/crypto.js';
import {
  resolveModelSubset,
  parseAllowedModels,
  isPassthroughKind,
  upstreamChatUrl,
  upstreamHeaders,
  buildUpstreamBody,
  extractUsageFromJson,
  extractUsageFromSseChunk,
  toModelsListResponse,
  type IncomingChatBody,
} from '../llm/relay-proxy.js';
import type { AppEnv } from '../app-env.js';

const ENDPOINT = '/api/llm/v1/chat/completions';

function openaiError(message: string, type = 'invalid_request_error', code?: string) {
  return { error: { message, type, code: code ?? null } };
}

/** Reject non-relay keys — the gateway is only for `channel='relay'` clients. */
async function relayChannelGuard(c: Context, next: Next) {
  const client = getApiClient(c);
  if (client.channel !== 'relay') {
    return c.json(openaiError('This API key cannot access the model gateway', 'auth_error'), 403);
  }
  return next();
}

async function recordAudit(
  client: ApiClientRow,
  statusCode: number,
  durationMs: number,
  ip: string,
  meta: Record<string, unknown>,
  error?: string,
  inputTokens?: number,
  outputTokens?: number,
): Promise<void> {
  try {
    await getDb().apiAudit.record({
      app_id: client.app_id,
      endpoint: ENDPOINT,
      method: 'POST',
      user_id: client.user_id ?? undefined,
      channel: 'relay',
      status_code: statusCode,
      duration_ms: durationMs,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      meta,
      ip_address: ip,
      error,
    });
  } catch (err) {
    logger.error('[llm-relay] failed to record audit:', err);
  }
}

/** Resolve the subset of enabled models this relay key may use. */
async function resolveKeyModels(client: ApiClientRow): Promise<LlmGatewayModelRow[]> {
  const enabled = await getDb().llmGatewayModels.listEnabled();
  return resolveModelSubset(parseAllowedModels(client.meta), enabled);
}

export function createLlmRelayRoutes() {
  return (
    new Hono<AppEnv>()
      // Auth → relay-channel guard → per-key rate limit. Same policy family as /api/v1.
      .use('*', apiKeyMiddleware)
      .use('*', relayChannelGuard)
      .use('*', createPerKeyRateLimitMiddleware('relay'))
      // ─── GET /v1/models ────────────────────────────────────
      .get('/v1/models', async (c) => {
        const client = getApiClient(c);
        const models = await resolveKeyModels(client);
        return c.json(toModelsListResponse(models));
      })
      // ─── POST /v1/chat/completions ─────────────────────────
      .post('/v1/chat/completions', async (c) => {
        const client = getApiClient(c);
        const ip = getClientIP(c);
        const startedAt = Date.now();

        const body = (await c.req.json().catch(() => null)) as IncomingChatBody | null;
        if (!body || typeof body !== 'object') {
          return c.json(openaiError('Request body must be valid JSON'), 400);
        }

        // ── Resolve the requested model within this key's subset ──
        const subset = await resolveKeyModels(client);
        if (subset.length === 0) {
          await recordAudit(client, 403, Date.now() - startedAt, ip, {}, 'No models available for this key');
          return c.json(openaiError('No models are available for this key', 'auth_error'), 403);
        }
        // Default to the catalog default (or first) when the client omits `model` — keeps the seamless path zero-config.
        const requested = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
        const model = requested
          ? subset.find((m) => m.public_id === requested)
          : (subset.find((m) => m.is_default) ?? subset[0]);

        if (!model) {
          await recordAudit(client, 404, Date.now() - startedAt, ip, { model: requested }, 'Model not available');
          return c.json(
            openaiError(
              `Model "${requested}" is not available for this key`,
              'invalid_request_error',
              'model_not_found',
            ),
            404,
          );
        }

        const upstream = await getDb().llmUpstreams.getById(model.upstream_id);
        if (!upstream || !upstream.enabled) {
          await recordAudit(
            client,
            503,
            Date.now() - startedAt,
            ip,
            { model: model.public_id },
            'Upstream unavailable',
          );
          return c.json(openaiError('The selected model is temporarily unavailable', 'api_error'), 503);
        }
        if (!isPassthroughKind(upstream.provider_kind)) {
          await recordAudit(
            client,
            501,
            Date.now() - startedAt,
            ip,
            { model: model.public_id, kind: upstream.provider_kind },
            'Upstream protocol not supported',
          );
          return c.json(openaiError('This model is not yet supported by the gateway', 'api_error'), 501);
        }
        if (!isEncryptionConfigured()) {
          await recordAudit(
            client,
            500,
            Date.now() - startedAt,
            ip,
            { model: model.public_id },
            'Encryption not configured',
          );
          return c.json(openaiError('Gateway is not configured (encryption key missing)', 'api_error'), 500);
        }

        // ── Daily token quota ──
        try {
          const used = await getDb().apiAudit.getDailyTokenUsage(client.app_id);
          if (used >= client.daily_token_limit) {
            await recordAudit(
              client,
              429,
              Date.now() - startedAt,
              ip,
              { model: model.public_id },
              'Daily token limit exceeded',
            );
            return c.json(openaiError('Daily token limit exceeded', 'rate_limit_error'), 429);
          }
        } catch {
          /* ignore quota lookup errors — fail open on the check, never on billing */
        }

        let apiKey: string;
        try {
          apiKey = decryptToken(upstream.api_key_enc);
        } catch (err) {
          logger.error('[llm-relay] failed to decrypt upstream key:', err);
          await recordAudit(client, 500, Date.now() - startedAt, ip, { model: model.public_id }, 'Key decrypt failed');
          return c.json(openaiError('Gateway upstream credential error', 'api_error'), 500);
        }

        const url = upstreamChatUrl(upstream.base_url);
        const headers = upstreamHeaders(upstream.provider_kind, apiKey);
        const upstreamBody = buildUpstreamBody(body, model.upstream_model);
        const wantStream = body.stream === true;
        const auditMeta = { model: model.public_id, upstream_id: upstream.id, upstream_model: model.upstream_model };

        let upstreamRes: Response;
        try {
          upstreamRes = await fetch(url, { method: 'POST', headers, body: JSON.stringify(upstreamBody) });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('[llm-relay] upstream fetch failed:', message);
          await recordAudit(client, 502, Date.now() - startedAt, ip, auditMeta, `Upstream fetch failed: ${message}`);
          return c.json(openaiError('Upstream request failed', 'api_error'), 502);
        }

        // ── Non-streaming: read JSON, account usage, passthrough ──
        if (!wantStream || !upstreamRes.body) {
          const text = await upstreamRes.text();
          const json = text ? (JSON.parse(text) as unknown) : {};
          const usage = extractUsageFromJson(json);
          await recordAudit(
            client,
            upstreamRes.status,
            Date.now() - startedAt,
            ip,
            auditMeta,
            upstreamRes.ok ? undefined : 'Upstream returned error',
            usage.inputTokens,
            usage.outputTokens,
          );
          return c.json(json as Record<string, unknown>, upstreamRes.status as 200);
        }

        // ── Streaming: tee SSE through to the client, scan for the final usage chunk ──
        c.header('Content-Type', upstreamRes.headers.get('content-type') ?? 'text/event-stream');
        c.header('Cache-Control', 'no-cache');
        c.header('Connection', 'keep-alive');

        const upstreamStatus = upstreamRes.status;
        return honoStream(c, async (stream) => {
          const reader = upstreamRes.body!.getReader();
          const decoder = new TextDecoder();
          let inputTokens = 0;
          let outputTokens = 0;
          let buffered = '';
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              buffered += chunk;
              // Scan only complete lines; keep the trailing partial in the buffer.
              const lines = buffered.split('\n');
              buffered = lines.pop() ?? '';
              for (const line of lines) {
                const usage = extractUsageFromSseChunk(line);
                if (usage) {
                  inputTokens = usage.inputTokens;
                  outputTokens = usage.outputTokens;
                }
              }
              await stream.write(chunk);
            }
          } catch (err) {
            const e = err as { code?: string; message?: string };
            if (e?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
              logger.info(`[llm-relay] stream interrupted: ${e?.message || String(err)}`);
            }
          } finally {
            await recordAudit(
              client,
              upstreamStatus,
              Date.now() - startedAt,
              ip,
              auditMeta,
              upstreamStatus >= 400 ? 'Upstream returned error' : undefined,
              inputTokens,
              outputTokens,
            );
          }
        });
      })
  );
}
