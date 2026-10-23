/**
 * 模型网关 — 成员自己的 Agent 用团队模型额度（两个线协议，同一套 Key、计价与规则）
 *
 * OpenAI 兼容 — /api/gateway/openai/v1
 * GET  /api/gateway/openai/v1/models                  — 这把 Key 能用的模型（目录 id，owned_by "greenhouse"）
 * POST /api/gateway/openai/v1/chat/completions        — Chat Completions，流式 / 非流式
 *
 * Anthropic 兼容 — /api/gateway/anthropic（Claude Code 的 ANTHROPIC_BASE_URL）
 * GET  /api/gateway/anthropic/v1/models               — 有 Anthropic 线上游的模型（Anthropic 列表形状）
 * GET  /api/gateway/anthropic/v1/models/:id           — 单个模型
 * POST /api/gateway/anthropic/v1/messages             — Messages，流式 / 非流式
 * POST /api/gateway/anthropic/v1/messages/count_tokens — 本地估算 {input_tokens}，不调上游、不计价
 *
 * 不走登录态：auth 中间件放行 `/api/gateway/`，这里只认成员的 ghgw Key（`Authorization: Bearer` 或
 * `x-api-key`）。CORS 关闭（security.ts），请求体上限 4 MB，每 Key 限流（默认 300/分）。
 * 工作区开关 `gateway.enabled` 关着时一律 403。计价与释放规则见 gateway/proxy.ts。
 * 绝不把成员的 ghgw Key 带去上游，错误里绝不出现上游 Key 或 URL。
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getModelRegistry } from '@greenhouse/agent-core';
import { gatewayKeyAllowedModels, type GatewayKeyRow } from '@greenhouse/db';
import {
  anthropicMessagesUrl,
  anthropicUpstreamHeaders,
  buildUpstreamBody,
  estimateCallTokens,
  estimateMessagesInputTokens,
  GatewayRequestError,
  listGatewayModels,
  parseAnthropicUsage,
  parseUsage,
  resolveGatewayModel,
  upstreamChatUrl,
  upstreamHeaders,
  validateChatRequest,
  validateMessagesRequest,
  type ChatRequestBody,
  type GatewayModel,
  type GatewayWire,
} from '../gateway/upstream.js';
import {
  anthropicError,
  createGatewayGuard,
  MAX_GATEWAY_BODY_BYTES,
  openAiError,
  proxyCall,
  type GatewayEnv,
  type GatewayErrorWriter,
} from '../gateway/proxy.js';
import type { Context } from 'hono';

export { _waitForGatewayCalls } from '../gateway/proxy.js';

function modelsFor(key: GatewayKeyRow, wire: GatewayWire): GatewayModel[] {
  return listGatewayModels(getModelRegistry(), gatewayKeyAllowedModels(key), process.env, wire);
}

function tooLarge(fail: GatewayErrorWriter) {
  return bodyLimit({
    maxSize: MAX_GATEWAY_BODY_BYTES,
    onError: (c) =>
      fail(
        c,
        413,
        `Request body is larger than ${MAX_GATEWAY_BODY_BYTES / (1024 * 1024)} MB.`,
        'invalid_request_error',
        'body_too_large',
      ),
  });
}

async function readBody(c: Context): Promise<ChatRequestBody | null> {
  const body = (await c.req.json().catch(() => null)) as ChatRequestBody | null;
  return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

/**
 * The catalog model a request names, allowed for this key and reachable on this
 * wire — or the error response saying which of the three it is not.
 */
function resolveRequested(
  c: Context,
  fail: GatewayErrorWriter,
  key: GatewayKeyRow,
  id: string,
  wire: GatewayWire,
): GatewayModel | Response {
  const entry = getModelRegistry()[id];
  const list = wire === 'anthropic' ? 'GET /v1/models' : 'GET /models';
  if (!entry) {
    return fail(
      c,
      404,
      `The model \`${id}\` does not exist. ${list} lists the models this key may use.`,
      'invalid_request_error',
      'model_not_found',
      'model',
    );
  }
  const allowed = gatewayKeyAllowedModels(key);
  if (allowed && !allowed.includes(id)) {
    return fail(
      c,
      403,
      `This gateway key may not use \`${id}\`. ${list} lists the models it may use.`,
      'permission_error',
      'model_not_allowed',
      'model',
    );
  }
  const model = resolveGatewayModel(id, entry, process.env, wire);
  if (!model) {
    return fail(
      c,
      503,
      wire === 'anthropic'
        ? `The model \`${id}\` has no Anthropic-compatible endpoint configured on this deployment.`
        : `The model \`${id}\` is not available through the gateway on this deployment.`,
      'api_error',
      'model_unavailable',
      'model',
    );
  }
  return model;
}

// ─── OpenAI Chat Completions ─────────────────────────────

export function createGatewayRoutes() {
  return new Hono<GatewayEnv>()
    .use('*', createGatewayGuard(openAiError))
    .get('/models', (c) =>
      c.json({
        object: 'list' as const,
        data: modelsFor(c.get('gatewayKey'), 'openai').map((model) => ({
          id: model.id,
          object: 'model' as const,
          created: 0,
          owned_by: 'greenhouse',
        })),
      }),
    )
    .post('/chat/completions', tooLarge(openAiError), async (c) => {
      const key = c.get('gatewayKey');
      const body = await readBody(c);
      if (!body)
        return openAiError(c, 400, 'Request body must be a JSON object.', 'invalid_request_error', 'invalid_json');
      let request;
      try {
        request = validateChatRequest(body);
      } catch (err) {
        if (!(err instanceof GatewayRequestError)) throw err;
        return openAiError(c, 400, err.message, 'invalid_request_error', 'invalid_request', err.param);
      }
      const model = resolveRequested(c, openAiError, key, request.model, 'openai');
      if (model instanceof Response) return model;
      return proxyCall(c, {
        wire: 'openai',
        fail: openAiError,
        key,
        model,
        stream: request.stream,
        clientWantsUsage: request.clientWantsUsage,
        estimate: estimateCallTokens(body, request, model),
        url: upstreamChatUrl(model.baseUrl),
        headers: upstreamHeaders(model.apiKey, request.stream),
        body: buildUpstreamBody(body, model.upstreamModel),
        parseUsage,
      });
    });
}

// ─── Anthropic Messages ──────────────────────────────────

const EPOCH = '1970-01-01T00:00:00Z';

function anthropicModelView(model: GatewayModel) {
  return { type: 'model' as const, id: model.id, display_name: model.name, created_at: EPOCH };
}

export function createAnthropicGatewayRoutes() {
  return new Hono<GatewayEnv>()
    .use('*', createGatewayGuard(anthropicError))
    .get('/v1/models', (c) => {
      const data = modelsFor(c.get('gatewayKey'), 'anthropic').map(anthropicModelView);
      return c.json({ data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
    })
    .get('/v1/models/:id', (c) => {
      const model = modelsFor(c.get('gatewayKey'), 'anthropic').find((entry) => entry.id === c.req.param('id'));
      if (!model) return anthropicError(c, 404, `The model \`${c.req.param('id')}\` is not available.`, '', null);
      return c.json(anthropicModelView(model));
    })
    .post('/v1/messages/count_tokens', tooLarge(anthropicError), async (c) => {
      const key = c.get('gatewayKey');
      const body = await readBody(c);
      if (!body) return anthropicError(c, 400, 'Request body must be a JSON object.', 'invalid_request_error', null);
      if (typeof body.model !== 'string' || !Array.isArray(body.messages)) {
        return anthropicError(c, 400, 'model and messages are required.', 'invalid_request_error', null);
      }
      const model = resolveRequested(c, anthropicError, key, body.model.trim(), 'anthropic');
      if (model instanceof Response) return model;
      // An estimate (no provider call, nothing metered): clients use it to size context, not to bill.
      return c.json({ input_tokens: estimateMessagesInputTokens(body, 1) });
    })
    .post('/v1/messages', tooLarge(anthropicError), async (c) => {
      const key = c.get('gatewayKey');
      const body = await readBody(c);
      if (!body) return anthropicError(c, 400, 'Request body must be a JSON object.', 'invalid_request_error', null);
      let request;
      try {
        request = validateMessagesRequest(body);
      } catch (err) {
        if (!(err instanceof GatewayRequestError)) throw err;
        return anthropicError(c, 400, err.message, 'invalid_request_error', null);
      }
      const model = resolveRequested(c, anthropicError, key, request.model, 'anthropic');
      if (model instanceof Response) return model;
      const window = model.contextWindow ?? 128_000;
      const url = anthropicMessagesUrl(model.baseUrl) + (c.req.query('beta') === 'true' ? '?beta=true' : '');
      return proxyCall(c, {
        wire: 'anthropic',
        fail: anthropicError,
        key,
        model,
        stream: request.stream,
        clientWantsUsage: true,
        estimate: {
          inputTokens: estimateMessagesInputTokens(body),
          outputTokens: Math.max(1, Math.min(request.requestedOutputTokens ?? 1, window)),
        },
        url,
        headers: anthropicUpstreamHeaders(model.apiKey, request.stream, {
          version: c.req.header('anthropic-version'),
          beta: c.req.header('anthropic-beta'),
        }),
        body: { ...body, model: model.upstreamModel },
        parseUsage: parseAnthropicUsage,
      });
    });
}
