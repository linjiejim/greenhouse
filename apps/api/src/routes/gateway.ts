/**
 * 模型网关 — /api/gateway/openai/v1（OpenAI 兼容；成员自己的 Agent 用团队模型额度）
 *
 * GET  /api/gateway/openai/v1/models            — 这把 Key 能用的模型（目录 id，owned_by "greenhouse"）
 * POST /api/gateway/openai/v1/chat/completions  — OpenAI Chat Completions，流式 / 非流式，按目录解析上游后转发
 *
 * 不走登录态：auth 中间件放行 `/api/gateway/`，这里只认 `Authorization: Bearer ghgw_…`
 * （成员在 设置 › Agent 连接 › 模型网关 建的 Key，库里只有 SHA-256）。CORS 关闭（security.ts），
 * 请求体上限 4 MB，按 Key 限流（rate_limit_buckets）。工作区开关 `gateway.enabled` 关着时一律 403。
 *
 * 计价：每次调用都过 usage/metering（reserveUserTokenBudget，service `llm`，client `gateway`，
 * 成员是 owner，Key id 进预留 metadata 与幂等键 `gateway:<keyId>:<uuid>`）。转发前按估算预留，
 * 拿到 usage 按模型价结算；上游 4xx（明确拒绝）释放；客户端断开、5xx、没有 usage = 结果未知，
 * 预留留给 TTL sweeper 按预估计费。超额 429 `insufficient_quota` / `usage_budget_exceeded`。
 * 绝不把成员的 ghgw Key 带去上游，错误里绝不出现上游 Key 或 URL。
 */

import { randomUUID } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { stream as honoStream } from 'hono/streaming';
import { getDb, gatewayKeyAllowedModels, gatewayKeyUsability, type GatewayKeyRow } from '@greenhouse/db';
import { GATEWAY_KEY_SECRET_PREFIX } from '@greenhouse/types/agent-access';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { getModelRegistry } from '@greenhouse/agent-core';
import { isGatewayEnabled } from '../gateway/keys.js';
import {
  buildUpstreamBody,
  estimateCallTokens,
  GatewayRequestError,
  listGatewayModels,
  parseUsage,
  readUpstreamError,
  resolveGatewayModel,
  sanitizeUpstreamText,
  SseUsageRelay,
  upstreamChatUrl,
  upstreamHeaders,
  validateChatRequest,
  type ChatRequestBody,
  type GatewayModel,
  type GatewayUsage,
} from '../gateway/upstream.js';
import {
  reserveUserTokenBudget,
  settleAndRecordBudgetedUsage,
  UsageBudgetAdmissionError,
  type UserTokenBudgetLease,
} from '../llm/usage-budget.js';
import { checkRateLimit } from '../security/security.js';
import { getRequestSourceIp } from '../security/request-ip.js';

export const GATEWAY_CALLER = 'gateway';
export const MAX_GATEWAY_BODY_BYTES = 4 * 1024 * 1024;
/** Per-IP ceiling on every gateway request (authenticated or not) — an abuse brake on key guessing. */
const IP_REQUESTS_PER_MINUTE = 600;
const DEFAULT_KEY_REQUESTS_PER_MINUTE = 60;

type GatewayEnv = { Variables: { gatewayKey: GatewayKeyRow } };
type ErrorStatus = 400 | 401 | 403 | 404 | 413 | 422 | 429 | 499 | 500 | 502 | 503;

/** Requests per minute one key may make (`GATEWAY_RATE_LIMIT_PER_MINUTE`, default 60). */
function keyRequestsPerMinute(): number {
  const raw = Number(process.env.GATEWAY_RATE_LIMIT_PER_MINUTE);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_KEY_REQUESTS_PER_MINUTE;
}

function openAiError(
  c: Context,
  status: ErrorStatus,
  message: string,
  type: string,
  code: string | null,
  param: string | null = null,
) {
  return c.json({ error: { message, type, code, param } }, status as 400);
}

// ─── Calls in flight (a streamed call settles after its response started) ──

const inFlight = new Set<Promise<unknown>>();

function track<T>(promise: Promise<T>): Promise<T> {
  inFlight.add(promise);
  void promise.finally(() => inFlight.delete(promise)).catch(() => undefined);
  return promise;
}

/** Test hook: resolves once every started gateway call has settled or given up. */
export async function _waitForGatewayCalls(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

// ─── Guard: switch → IP brake → key → owner → per-key limit ──

const gatewayGuard: MiddlewareHandler<GatewayEnv> = async (c, next) => {
  if (!(await isGatewayEnabled())) {
    return openAiError(
      c,
      403,
      'The model gateway is turned off for this workspace. Ask an administrator to enable it (Administration › Runtime Config › Model gateway).',
      'permission_error',
      'gateway_disabled',
    );
  }
  const ip = getRequestSourceIp(c);
  const ipLimit = await checkRateLimit(`gateway:ip:${ip}`, 60_000, IP_REQUESTS_PER_MINUTE);
  if (!ipLimit.allowed) {
    c.header('Retry-After', String(Math.max(1, Math.ceil((ipLimit.resetAt - Date.now()) / 1000))));
    return openAiError(
      c,
      429,
      'Too many requests from this address. Retry later.',
      'rate_limit_error',
      'rate_limit_exceeded',
    );
  }

  const header = c.req.header('Authorization') ?? '';
  const secret = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!secret.startsWith(GATEWAY_KEY_SECRET_PREFIX)) {
    return openAiError(
      c,
      401,
      'Missing or invalid gateway key. Send `Authorization: Bearer ghgw_…` with a key from Settings › Agent connections › Model gateway.',
      'invalid_request_error',
      'invalid_api_key',
    );
  }
  const db = getDb();
  const key = await db.gatewayKeys.findBySecret(secret);
  if (!key) {
    return openAiError(c, 401, 'Invalid gateway key.', 'invalid_request_error', 'invalid_api_key');
  }
  const usability = gatewayKeyUsability(key);
  if (usability !== 'active') {
    return openAiError(
      c,
      401,
      usability === 'revoked' ? 'This gateway key was revoked.' : 'This gateway key has expired.',
      'invalid_request_error',
      usability === 'revoked' ? 'gateway_key_revoked' : 'gateway_key_expired',
    );
  }
  const owner = await db.users.getById(key.user_id);
  if (!owner || owner.status !== 'active' || (owner.role !== 'team' && owner.role !== 'super')) {
    return openAiError(
      c,
      403,
      'The member this key belongs to is unavailable.',
      'permission_error',
      'account_unavailable',
    );
  }
  const keyLimit = keyRequestsPerMinute();
  const limit = await checkRateLimit(`gateway:key:${key.id}`, 60_000, keyLimit);
  c.header('X-RateLimit-Limit', String(keyLimit));
  c.header('X-RateLimit-Remaining', String(limit.remaining));
  if (!limit.allowed) {
    c.header('Retry-After', String(Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000))));
    return openAiError(
      c,
      429,
      `This gateway key is limited to ${keyLimit} requests per minute. Retry later.`,
      'rate_limit_error',
      'rate_limit_exceeded',
    );
  }
  await db.gatewayKeys.touchLastUsed(key.id).catch((err: unknown) => {
    logger.warn('[gateway] could not stamp key use', { key: key.id, error: toErrorMessage(err) });
  });
  c.set('gatewayKey', key);
  return next();
};

function modelsFor(key: GatewayKeyRow): GatewayModel[] {
  return listGatewayModels(getModelRegistry(), gatewayKeyAllowedModels(key));
}

// ─── Settlement ──────────────────────────────────────────

interface CallContext {
  key: GatewayKeyRow;
  model: GatewayModel;
  lease: UserTokenBudgetLease;
  startedAt: number;
}

async function settleCall(call: CallContext, usage: GatewayUsage): Promise<void> {
  try {
    await settleAndRecordBudgetedUsage(getDb(), call.lease, {
      profile_id: GATEWAY_CALLER,
      caller: GATEWAY_CALLER,
      user_id: call.key.user_id,
      model: call.model.upstreamModel,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cached_tokens: usage.cachedTokens,
      reasoning_tokens: usage.reasoningTokens,
      duration_ms: Date.now() - call.startedAt,
    });
  } catch (err) {
    // The reservation stays; the sweeper charges the estimate.
    logger.warn('[gateway] could not settle a call', { key: call.lease.idempotencyKey, error: toErrorMessage(err) });
  }
}

/** A definite refusal (or a request that never left): nothing billed, give the reservation back. */
async function releaseCall(call: CallContext, reason: string): Promise<void> {
  try {
    await call.lease.releaseAfterProviderRefusal(reason);
  } catch (err) {
    logger.warn('[gateway] could not release a refused call', {
      key: call.lease.idempotencyKey,
      error: toErrorMessage(err),
    });
  }
}

/** Unknown outcome: the provider may have billed. Keep the reservation for the TTL sweeper. */
function leaveReserved(call: CallContext, reason: string): void {
  logger.warn('[gateway] call outcome unknown; reservation expires at the estimate', {
    key: call.lease.idempotencyKey,
    reason,
  });
}

const UNSENT_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/** The request provably never reached the provider (refused / unresolvable connection). */
function neverSent(err: unknown): boolean {
  let cursor: unknown = err;
  for (let depth = 0; cursor && depth < 4; depth++) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string' && UNSENT_ERROR_CODES.has(code)) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/** Map an upstream non-2xx answer to the member's error; refusals (4xx) release, failures (5xx) stay reserved. */
async function upstreamFailure(c: Context, call: CallContext, response: Response) {
  const text = await response.text().catch(() => '');
  const status = response.status;
  const usage = parseUsage(
    (() => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    })(),
  );
  if (status >= 500) {
    if (usage) await settleCall(call, usage);
    else leaveReserved(call, `upstream_${status}`);
    return openAiError(
      c,
      502,
      `The model provider failed (HTTP ${status}). Try again later.`,
      'api_error',
      'upstream_error',
    );
  }
  if (usage) await settleCall(call, usage);
  else await releaseCall(call, `upstream_refused_${status}`);
  if (status === 401 || status === 403) {
    return openAiError(
      c,
      502,
      "The model provider refused Greenhouse's credentials. Ask an administrator to check the model configuration.",
      'api_error',
      'upstream_auth_failed',
    );
  }
  if (status === 429) {
    return openAiError(
      c,
      429,
      "The model provider is rate-limiting the team's requests. Retry later.",
      'rate_limit_error',
      'upstream_rate_limited',
    );
  }
  const upstream = readUpstreamError(text);
  const message = upstream.message ? sanitizeUpstreamText(upstream.message, call.model) : `HTTP ${status}`;
  const mapped: ErrorStatus = status === 404 || status === 413 || status === 422 ? status : 400;
  return openAiError(
    c,
    mapped,
    `The model provider rejected the request: ${message}`,
    upstream.type && /^[a-z_]{1,40}$/.test(upstream.type) ? upstream.type : 'invalid_request_error',
    upstream.code && /^[A-Za-z0-9_.-]{1,60}$/.test(upstream.code) ? upstream.code : 'upstream_rejected',
  );
}

// ─── Routes ──────────────────────────────────────────────

export function createGatewayRoutes() {
  return new Hono<GatewayEnv>()
    .use('*', gatewayGuard)
    .get('/models', (c) => {
      const models = modelsFor(c.get('gatewayKey'));
      return c.json({
        object: 'list' as const,
        data: models.map((model) => ({
          id: model.id,
          object: 'model' as const,
          created: 0,
          owned_by: 'greenhouse',
        })),
      });
    })
    .post(
      '/chat/completions',
      bodyLimit({
        maxSize: MAX_GATEWAY_BODY_BYTES,
        onError: (c) =>
          openAiError(
            c,
            413,
            `Request body is larger than ${MAX_GATEWAY_BODY_BYTES / (1024 * 1024)} MB.`,
            'invalid_request_error',
            'body_too_large',
          ),
      }),
      async (c) => {
        const key = c.get('gatewayKey');
        const startedAt = Date.now();
        const body = (await c.req.json().catch(() => null)) as ChatRequestBody | null;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return openAiError(c, 400, 'Request body must be a JSON object.', 'invalid_request_error', 'invalid_json');
        }
        let request;
        try {
          request = validateChatRequest(body);
        } catch (err) {
          if (!(err instanceof GatewayRequestError)) throw err;
          return openAiError(c, 400, err.message, 'invalid_request_error', 'invalid_request', err.param);
        }

        // ── The model: in the catalog, allowed for this key, reachable here ──
        const entry = getModelRegistry()[request.model];
        if (!entry) {
          return openAiError(
            c,
            404,
            `The model \`${request.model}\` does not exist. GET /models lists the models this key may use.`,
            'invalid_request_error',
            'model_not_found',
            'model',
          );
        }
        const allowed = gatewayKeyAllowedModels(key);
        if (allowed && !allowed.includes(request.model)) {
          return openAiError(
            c,
            403,
            `This gateway key may not use \`${request.model}\`. GET /models lists the models it may use.`,
            'permission_error',
            'model_not_allowed',
            'model',
          );
        }
        const model = resolveGatewayModel(request.model, entry);
        if (!model) {
          return openAiError(
            c,
            503,
            `The model \`${request.model}\` is not available through the gateway on this deployment.`,
            'api_error',
            'model_unavailable',
            'model',
          );
        }

        // ── Reserve before any provider I/O ──
        const estimate = estimateCallTokens(body, request, model);
        let lease: UserTokenBudgetLease;
        try {
          lease = await reserveUserTokenBudget({
            db: getDb(),
            userId: key.user_id,
            caller: GATEWAY_CALLER,
            estimatedTokens: estimate.inputTokens + estimate.outputTokens,
            estimatedInputTokens: estimate.inputTokens,
            estimatedOutputTokens: estimate.outputTokens,
            modelId: model.upstreamModel,
            logicalModelId: model.id,
            providerId: model.provider,
            providerScopeOverride: model.scopeId,
            idempotencyKey: `${GATEWAY_CALLER}:${key.id}:${randomUUID()}`,
            client: 'gateway',
            metadata: {
              gateway_key_id: key.id,
              logical_model: model.id,
              provider_model: model.upstreamModel,
              stream: request.stream,
            },
          });
        } catch (err) {
          if (err instanceof UsageBudgetAdmissionError) {
            if (err.status === 429) {
              return openAiError(c, 429, err.message, 'insufficient_quota', 'usage_budget_exceeded');
            }
            return openAiError(
              c,
              err.status,
              err.message,
              err.status === 403 ? 'permission_error' : 'api_error',
              err.code,
            );
          }
          throw err;
        }
        const call: CallContext = { key, model, lease, startedAt };

        // ── Forward: the upstream key only, never anything the client sent ──
        const upstream = new AbortController();
        const clientSignal = c.req.raw.signal;
        const onClientGone = () => upstream.abort();
        clientSignal?.addEventListener('abort', onClientGone, { once: true });
        lease.markProviderIoStarted();
        let response: Response;
        try {
          response = await fetch(upstreamChatUrl(model.baseUrl), {
            method: 'POST',
            headers: upstreamHeaders(model.apiKey, request.stream),
            body: JSON.stringify(buildUpstreamBody(body, model.upstreamModel)),
            signal: upstream.signal,
          });
        } catch (err) {
          clientSignal?.removeEventListener('abort', onClientGone);
          if (upstream.signal.aborted) {
            leaveReserved(call, 'client_disconnected');
            return openAiError(c, 499, 'The client closed the request.', 'api_error', 'client_closed');
          }
          if (neverSent(err)) {
            await releaseCall(call, 'upstream_unreachable');
          } else {
            leaveReserved(call, 'upstream_fetch_failed');
          }
          logger.warn('[gateway] upstream request failed', { model: model.id, error: toErrorMessage(err) });
          return openAiError(
            c,
            502,
            'The model provider could not be reached. Try again later.',
            'api_error',
            'upstream_unavailable',
          );
        }

        if (!response.ok) {
          clientSignal?.removeEventListener('abort', onClientGone);
          return track(upstreamFailure(c, call, response));
        }

        const isEventStream = (response.headers.get('content-type') ?? '').includes('text/event-stream');
        if (!request.stream || !isEventStream || !response.body) {
          // ── Non-streaming: read the JSON, settle from its usage, pass it through ──
          return track(
            (async () => {
              let text: string;
              try {
                text = await response.text();
              } catch {
                leaveReserved(call, upstream.signal.aborted ? 'client_disconnected' : 'upstream_body_failed');
                return openAiError(c, 502, 'The model provider response was cut off.', 'api_error', 'upstream_error');
              } finally {
                clientSignal?.removeEventListener('abort', onClientGone);
              }
              let json: unknown;
              try {
                json = JSON.parse(text);
              } catch {
                leaveReserved(call, 'upstream_invalid_json');
                return openAiError(
                  c,
                  502,
                  'The model provider returned an unreadable response.',
                  'api_error',
                  'upstream_invalid_response',
                );
              }
              const usage = parseUsage(json);
              if (usage) await settleCall(call, usage);
              else leaveReserved(call, 'usage_missing');
              return c.body(text, 200, { 'content-type': 'application/json' });
            })(),
          );
        }

        // ── Streaming: relay SSE as it arrives, settle from the final usage chunk ──
        c.header('Content-Type', 'text/event-stream; charset=utf-8');
        c.header('Cache-Control', 'no-cache');
        c.header('X-Accel-Buffering', 'no');
        const relay = new SseUsageRelay(!request.clientWantsUsage);
        const upstreamBody = response.body;
        return honoStream(c, (out) =>
          track(
            (async () => {
              out.onAbort(() => upstream.abort());
              const reader = upstreamBody.getReader();
              const decoder = new TextDecoder();
              try {
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  const text = relay.push(decoder.decode(value, { stream: true }));
                  if (text && !out.aborted) await out.write(text);
                }
                const rest = relay.push(decoder.decode()) + relay.flush();
                if (rest && !out.aborted) await out.write(rest);
              } catch (err) {
                if (!upstream.signal.aborted) {
                  logger.info('[gateway] upstream stream interrupted', { error: toErrorMessage(err) });
                }
              } finally {
                clientSignal?.removeEventListener('abort', onClientGone);
                // Close the upstream connection whatever happened (a no-op once it ended).
                void reader.cancel().catch(() => undefined);
              }
              if (relay.usage) await settleCall(call, relay.usage);
              else
                leaveReserved(call, out.aborted || upstream.signal.aborted ? 'client_disconnected' : 'usage_missing');
            })(),
          ),
        );
      },
    );
}
