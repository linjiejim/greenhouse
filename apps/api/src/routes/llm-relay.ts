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

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { stream as honoStream } from 'hono/streaming';
import { logger } from '@greenhouse/utils/logger';
import { safeJsonParse } from '@greenhouse/utils/json';
import { getDb } from '@greenhouse/db';
import type { ApiClientRow } from '@greenhouse/db';
import { apiKeyMiddleware, getApiClient, getClientIP, createPerKeyRateLimitMiddleware } from '../auth/api-key.js';
import {
  resolveModelSubset,
  resolveRelayModel,
  parseAllowedModels,
  upstreamChatUrl,
  upstreamHeaders,
  buildUpstreamBody,
  extractUsageFromJson,
  extractUsageFromSseChunk,
  toModelsListResponse,
  buildRelayBudgetAttempt,
  applyRelayOutputLimit,
  RelayRequestError,
  type IncomingChatBody,
  type RelayModel,
} from '../llm/relay-proxy.js';
import { getModelCatalog } from '../config/models.js';
import type { AppEnv } from '../app-env.js';
import { getMissionRuntimeStatus } from '../cloud-agent/index.js';
import { beginMissionRelayRequest, type MissionRelayRequestHandle } from '../cloud-agent/relay-requests.js';
import {
  estimateRelayTokens,
  reserveUserTokenBudget,
  settleAndRecordBudgetedUsage,
  UsageBudgetAdmissionError,
} from '../llm/usage-budget.js';

const ENDPOINT = '/api/llm/v1/chat/completions';
export const MAX_RELAY_BODY_BYTES = 2 * 1024 * 1024;

function openaiError(message: string, type = 'invalid_request_error', code?: string) {
  return { error: { message, type, code: code ?? null } };
}

/** Require a relay key whose bound account is still an active internal user. */
export async function relayChannelGuard(c: Context, next: Next) {
  const client = getApiClient(c);
  if (client.channel !== 'relay') {
    return c.json(openaiError('This API key cannot access the model gateway', 'auth_error'), 403);
  }

  let user;
  try {
    user = await getDb().users.getById(client.user_id);
  } catch (err) {
    logger.error('[llm-relay] bound user lookup failed:', err);
    return c.json(openaiError('Internal server error', 'server_error'), 500);
  }
  if (!user || user.status !== 'active') {
    return c.json(openaiError('The user bound to this key is unavailable or disabled', 'auth_error'), 403);
  }
  if (user.role !== 'super' && user.role !== 'team') {
    return c.json(openaiError('The model gateway requires an internal user', 'auth_error'), 403);
  }

  const meta = safeJsonParse(client.meta, {}) as { cloud_agent_run_id?: unknown };
  if (typeof meta.cloud_agent_run_id === 'string') {
    if (getMissionRuntimeStatus().state !== 'ready') {
      return c.json(openaiError('Mission runtime is unavailable', 'server_error', 'mission_runtime_unavailable'), 503);
    }
    const run = await getDb().agentRuns.getRunById(meta.cloud_agent_run_id);
    if (!run || run.user_id !== client.user_id || (run.status !== 'starting' && run.status !== 'running')) {
      return c.json(openaiError('The Mission bound to this key is no longer active', 'auth_error'), 403);
    }
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
      user_id: client.user_id,
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

/**
 * Resolve the models this relay key may use, down to a reachable upstream.
 * Catalog + keys come from config/env, so this is a pure in-memory lookup.
 */
function resolveKeyModels(client: ApiClientRow): RelayModel[] {
  const catalog = getModelCatalog();
  const ids = resolveModelSubset(parseAllowedModels(client.meta), Object.keys(catalog.models), catalog.relay.public);
  return ids
    .map((id) => resolveRelayModel(id, catalog.models[id]!))
    .filter((model): model is RelayModel => model !== null);
}

function missionRunId(client: ApiClientRow): string | null {
  const meta = safeJsonParse(client.meta, {}) as { cloud_agent_run_id?: unknown };
  return typeof meta.cloud_agent_run_id === 'string' ? meta.cloud_agent_run_id : null;
}

export function createLlmRelayRoutes() {
  return (
    new Hono<AppEnv>()
      // Auth → relay-channel guard → per-key rate limit.
      .use('*', apiKeyMiddleware)
      .use('*', relayChannelGuard)
      .use('*', createPerKeyRateLimitMiddleware('relay'))
      // ─── GET /v1/models ────────────────────────────────────
      .get('/v1/models', async (c) => {
        const client = getApiClient(c);
        return c.json(toModelsListResponse(resolveKeyModels(client)));
      })
      // ─── POST /v1/chat/completions ─────────────────────────
      .post(
        '/v1/chat/completions',
        bodyLimit({
          maxSize: MAX_RELAY_BODY_BYTES,
          onError: (c) =>
            c.json(openaiError('Request body is too large', 'invalid_request_error', 'body_too_large'), 413),
        }),
        async (c) => {
          const client = getApiClient(c);
          const ip = getClientIP(c);
          const startedAt = Date.now();

          const body = (await c.req.json().catch(() => null)) as IncomingChatBody | null;
          if (!body || typeof body !== 'object') {
            return c.json(openaiError('Request body must be valid JSON'), 400);
          }

          // ── Resolve the requested model within this key's subset ──
          const subset = resolveKeyModels(client);
          if (subset.length === 0) {
            await recordAudit(client, 403, Date.now() - startedAt, ip, {}, 'No models available for this key');
            return c.json(openaiError('No models are available for this key', 'auth_error'), 403);
          }
          // Default to the config default (else the first) when the client omits
          // `model` — keeps the seamless path zero-config.
          const requested = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
          const fallbackId = getModelCatalog().relay.default;
          const model = requested
            ? subset.find((m) => m.id === requested)
            : (subset.find((m) => m.id === fallbackId) ?? subset[0]);

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

          // ── Daily token quota ──
          try {
            const used = await getDb().apiAudit.getDailyTokenUsage(client.app_id);
            if (used >= client.daily_token_limit) {
              await recordAudit(
                client,
                429,
                Date.now() - startedAt,
                ip,
                { model: model.id },
                'Daily token limit exceeded',
              );
              return c.json(openaiError('Daily token limit exceeded', 'rate_limit_error'), 429);
            }
          } catch {
            /* ignore quota lookup errors — fail open on the check, never on billing */
          }

          const catalogEntry = getModelCatalog().models[model.id];
          let boundedBody: IncomingChatBody;
          let outputTokenLimit: number;
          try {
            ({ body: boundedBody, outputTokenLimit } = applyRelayOutputLimit(
              body,
              catalogEntry?.options?.max_tokens ?? 20_000,
            ));
          } catch (error) {
            if (!(error instanceof RelayRequestError)) throw error;
            await recordAudit(client, 400, Date.now() - startedAt, ip, { model: model.id }, error.message);
            return c.json(openaiError(error.message), 400);
          }

          const url = upstreamChatUrl(model.baseUrl);
          const headers = upstreamHeaders(model.provider, model.apiKey);
          const upstreamBody = buildUpstreamBody(boundedBody, model.upstreamModel, model.provider);
          const wantStream = body.stream === true;
          const auditMeta = { model: model.id, provider: model.provider, upstream_model: model.upstreamModel };

          // A Mission relay key is visible inside an untrusted sandbox. Enforce
          // its per-Run request cap here, immediately before any provider budget
          // or network I/O. The runner's local counter is telemetry only and may
          // never be trusted as the admission boundary.
          const boundMissionRunId = missionRunId(client);
          if (boundMissionRunId) {
            const requestAdmission = await getDb().agentRuns.reserveRequest(boundMissionRunId, client.user_id);
            if (!requestAdmission.ok) {
              const exhausted = requestAdmission.reason === 'request_limit_exhausted';
              await recordAudit(
                client,
                exhausted ? 429 : 403,
                Date.now() - startedAt,
                ip,
                auditMeta,
                exhausted ? 'Mission request limit exceeded' : 'Mission is no longer active',
              );
              return c.json(
                openaiError(
                  exhausted ? 'Mission request limit exceeded' : 'The Mission bound to this key is no longer active',
                  exhausted ? 'rate_limit_error' : 'auth_error',
                  exhausted ? 'mission_request_limit_exceeded' : 'mission_not_active',
                ),
                exhausted ? 429 : 403,
              );
            }
          }

          const clientIdempotencyKey = c.req.header('idempotency-key')?.trim().slice(0, 160) || undefined;
          const budgetAttempt = buildRelayBudgetAttempt(client.id, clientIdempotencyKey, randomUUID());
          let budget;
          try {
            budget = await reserveUserTokenBudget({
              db: getDb(),
              userId: client.user_id,
              caller: 'llm-relay',
              estimatedTokens: estimateRelayTokens(upstreamBody, outputTokenLimit),
              modelId: model.id,
              providerId: model.provider,
              providerScopeOverride: model.scopeId,
              idempotencyKey: budgetAttempt.idempotencyKey,
              metadata: { app_id: client.app_id, stream: wantStream, ...budgetAttempt.metadata },
            });
          } catch (err) {
            const admission =
              err instanceof UsageBudgetAdmissionError
                ? err
                : new UsageBudgetAdmissionError('Usage budget is unavailable', 503, 'usage_budget_unavailable');
            await recordAudit(
              client,
              admission.status,
              Date.now() - startedAt,
              ip,
              auditMeta,
              `${admission.code}: ${admission.message}`,
            );
            return c.json(
              openaiError(
                admission.message,
                admission.status === 429 ? 'rate_limit_error' : 'server_error',
                admission.code,
              ),
              admission.status,
            );
          }

          let missionRelayRequest: MissionRelayRequestHandle | undefined;
          if (boundMissionRunId) {
            missionRelayRequest = beginMissionRelayRequest(boundMissionRunId);
            const activeRun = await getDb().agentRuns.getRunById(boundMissionRunId);
            if (
              !activeRun ||
              activeRun.user_id !== client.user_id ||
              (activeRun.status !== 'starting' && activeRun.status !== 'running')
            ) {
              missionRelayRequest.close();
              await budget.releaseBeforeProviderIo('mission_canceled_before_provider_io');
              await recordAudit(
                client,
                403,
                Date.now() - startedAt,
                ip,
                auditMeta,
                'Mission canceled before provider I/O',
              );
              return c.json(
                openaiError('The Mission bound to this key is no longer active', 'auth_error', 'mission_not_active'),
                403,
              );
            }
          }

          let upstreamRes: Response;
          try {
            if (missionRelayRequest?.signal.aborted) {
              missionRelayRequest.close();
              await budget.releaseBeforeProviderIo('mission_canceled_before_provider_io');
              return c.json(
                openaiError('The Mission bound to this key is no longer active', 'auth_error', 'mission_not_active'),
                403,
              );
            }
            budget.markProviderIoStarted();
            upstreamRes = await fetch(url, {
              method: 'POST',
              headers,
              body: JSON.stringify(upstreamBody),
              ...(missionRelayRequest ? { signal: missionRelayRequest.signal } : {}),
            });
          } catch (err) {
            missionRelayRequest?.close();
            const message = err instanceof Error ? err.message : String(err);
            logger.error('[llm-relay] upstream fetch failed:', message);
            await recordAudit(client, 502, Date.now() - startedAt, ip, auditMeta, `Upstream fetch failed: ${message}`);
            return c.json(openaiError('Upstream request failed', 'api_error'), 502);
          }

          // ── Non-streaming: read JSON, account usage, passthrough ──
          if (!wantStream || !upstreamRes.body) {
            const text = await upstreamRes.text().finally(() => missionRelayRequest?.close());
            const json = text ? (JSON.parse(text) as unknown) : {};
            const usage = extractUsageFromJson(json);
            if (usage.inputTokens || usage.outputTokens) {
              try {
                await settleAndRecordBudgetedUsage(getDb(), budget, {
                  profile_id: 'relay',
                  caller: 'llm-relay',
                  user_id: client.user_id,
                  model: model.id,
                  input_tokens: usage.inputTokens,
                  output_tokens: usage.outputTokens,
                  duration_ms: Date.now() - startedAt,
                });
              } catch (err) {
                logger.warn('[llm-relay] failed to settle budgeted usage', {
                  budgetKey: budget.idempotencyKey,
                  error: String(err),
                });
              }
            } else {
              logger.warn('[llm-relay] upstream returned no usage; reservation will expire conservatively', {
                budgetKey: budget.idempotencyKey,
                status: upstreamRes.status,
              });
            }
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
              missionRelayRequest?.close();
              if (inputTokens || outputTokens) {
                try {
                  await settleAndRecordBudgetedUsage(getDb(), budget, {
                    profile_id: 'relay',
                    caller: 'llm-relay',
                    user_id: client.user_id,
                    model: model.id,
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                    duration_ms: Date.now() - startedAt,
                  });
                } catch (err) {
                  logger.warn('[llm-relay] failed to settle streamed budgeted usage', {
                    budgetKey: budget.idempotencyKey,
                    error: String(err),
                  });
                }
              } else {
                logger.warn('[llm-relay] stream ended without usage; reservation will expire conservatively', {
                  budgetKey: budget.idempotencyKey,
                  status: upstreamStatus,
                });
              }
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
        },
      )
  );
}
