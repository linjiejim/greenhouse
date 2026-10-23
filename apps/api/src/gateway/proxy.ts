/**
 * Model gateway — the shared half of both surfaces (OpenAI Chat Completions and
 * Anthropic Messages): the key guard, the wire's error body, and one metered
 * proxy call (reserve → forward → settle / release / leave reserved).
 *
 * Metering rules, identical on both wires:
 *   - reserve before any provider I/O (reserveUserTokenBudget, client
 *     `gateway`, service `llm`, the member as owner, idempotency key
 *     `gateway:<keyId>:<uuid>`, `gateway_key_id` in the reservation metadata
 *     and on the llm_usage fact);
 *   - settle from the provider's usage (non-stream body, or the stream's final
 *     usage event);
 *   - release on a definite refusal: an upstream 4xx, or a connection that was
 *     refused / never resolved;
 *   - otherwise (client hung up, 5xx, success without usage) the outcome is
 *     unknown: the reservation stays and the TTL sweeper charges the estimate.
 */

import { randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { getDb, gatewayKeyUsability, type GatewayKeyRow } from '@greenhouse/db';
import { GATEWAY_KEY_SECRET_PREFIX } from '@greenhouse/types/agent-access';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { isGatewayEnabled } from './keys.js';
import {
  readUpstreamError,
  sanitizeUpstreamText,
  SseUsageRelay,
  type GatewayModel,
  type GatewayUsage,
  type GatewayWire,
} from './upstream.js';
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
/** Claude Code makes many small calls per turn; a key gets this many per minute by default. */
export const DEFAULT_KEY_REQUESTS_PER_MINUTE = 300;

export type GatewayEnv = { Variables: { gatewayKey: GatewayKeyRow } };
export type ErrorStatus = 400 | 401 | 403 | 404 | 413 | 422 | 429 | 499 | 500 | 502 | 503 | 529;

/** Requests per minute one key may make (`GATEWAY_RATE_LIMIT_PER_MINUTE`, default 300). */
export function keyRequestsPerMinute(): number {
  const raw = Number(process.env.GATEWAY_RATE_LIMIT_PER_MINUTE);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_KEY_REQUESTS_PER_MINUTE;
}

// ─── Error bodies ────────────────────────────────────────

/**
 * One gateway error in the wire's own shape. `type` / `code` are OpenAI's
 * vocabulary; the Anthropic writer keeps `type` only when it is one of
 * Anthropic's, else derives it from the status, and has no `code`.
 */
export type GatewayErrorWriter = (
  c: Context,
  status: ErrorStatus,
  message: string,
  type: string,
  code: string | null,
  param?: string | null,
) => Response;

export const openAiError: GatewayErrorWriter = (c, status, message, type, code, param = null) =>
  c.json({ error: { message, type, code, param } }, status as 400);

const ANTHROPIC_ERROR_TYPES = new Set([
  'invalid_request_error',
  'authentication_error',
  'billing_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
  'rate_limit_error',
  'api_error',
  'timeout_error',
  'overloaded_error',
]);

function anthropicTypeFor(status: number): string {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limit_error';
  if (status === 529) return 'overloaded_error';
  if (status >= 500 || status === 499) return 'api_error';
  return 'invalid_request_error';
}

export const anthropicError: GatewayErrorWriter = (c, status, message, type) => {
  // OpenAI's `invalid_request_error` on a 401 (a bad key) is Anthropic's `authentication_error`.
  const anthropicType =
    ANTHROPIC_ERROR_TYPES.has(type) && !(status === 401 && type === 'invalid_request_error')
      ? type
      : anthropicTypeFor(status);
  return c.json({ type: 'error', error: { type: anthropicType, message } }, status as 400);
};

// ─── Calls in flight (a streamed call settles after its response started) ──

const inFlight = new Set<Promise<unknown>>();

export function track<T>(promise: Promise<T>): Promise<T> {
  inFlight.add(promise);
  void promise.finally(() => inFlight.delete(promise)).catch(() => undefined);
  return promise;
}

/** Test hook: resolves once every started gateway call has settled or given up. */
export async function _waitForGatewayCalls(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

// ─── Guard: switch → IP brake → key → owner → per-key limit ──

/** The presented key: `Authorization: Bearer ghgw_…` or `x-api-key: ghgw_…` (Claude Code sends either). */
function presentedSecret(c: Context): string {
  const header = c.req.header('Authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (bearer.startsWith(GATEWAY_KEY_SECRET_PREFIX)) return bearer;
  const apiKey = c.req.header('x-api-key')?.trim() ?? '';
  return apiKey.startsWith(GATEWAY_KEY_SECRET_PREFIX) ? apiKey : '';
}

export function createGatewayGuard(fail: GatewayErrorWriter): MiddlewareHandler<GatewayEnv> {
  return async (c, next) => {
    if (!(await isGatewayEnabled())) {
      return fail(
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
      return fail(
        c,
        429,
        'Too many requests from this address. Retry later.',
        'rate_limit_error',
        'rate_limit_exceeded',
      );
    }

    const secret = presentedSecret(c);
    if (!secret) {
      return fail(
        c,
        401,
        'Missing or invalid gateway key. Send `Authorization: Bearer ghgw_…` (or `x-api-key: ghgw_…`) with a key from Settings › Agent connections › Model gateway.',
        'invalid_request_error',
        'invalid_api_key',
      );
    }
    const db = getDb();
    const key = await db.gatewayKeys.findBySecret(secret);
    if (!key) return fail(c, 401, 'Invalid gateway key.', 'invalid_request_error', 'invalid_api_key');
    const usability = gatewayKeyUsability(key);
    if (usability !== 'active') {
      return fail(
        c,
        401,
        usability === 'revoked' ? 'This gateway key was revoked.' : 'This gateway key has expired.',
        'invalid_request_error',
        usability === 'revoked' ? 'gateway_key_revoked' : 'gateway_key_expired',
      );
    }
    const owner = await db.users.getById(key.user_id);
    if (!owner || owner.status !== 'active' || (owner.role !== 'team' && owner.role !== 'super')) {
      return fail(c, 403, 'The member this key belongs to is unavailable.', 'permission_error', 'account_unavailable');
    }
    const keyLimit = keyRequestsPerMinute();
    const limit = await checkRateLimit(`gateway:key:${key.id}`, 60_000, keyLimit);
    c.header('X-RateLimit-Limit', String(keyLimit));
    c.header('X-RateLimit-Remaining', String(limit.remaining));
    if (!limit.allowed) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000))));
      return fail(
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
      gateway_key_id: call.key.id,
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// ─── One metered call ────────────────────────────────────

export interface ProxyCallInput {
  wire: GatewayWire;
  fail: GatewayErrorWriter;
  key: GatewayKeyRow;
  model: GatewayModel;
  stream: boolean;
  /** Messages wire always keeps usage events; Chat Completions drops the usage-only chunk unless asked. */
  clientWantsUsage: boolean;
  estimate: { inputTokens: number; outputTokens: number };
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  parseUsage: (json: unknown) => GatewayUsage | null;
}

/** Map an upstream non-2xx answer to the member's error; refusals (4xx) release, failures (5xx) stay reserved. */
async function upstreamFailure(c: Context, input: ProxyCallInput, call: CallContext, response: Response) {
  const { fail } = input;
  const text = await response.text().catch(() => '');
  const status = response.status;
  const usage = input.parseUsage(parseJson(text));
  if (status >= 500) {
    if (usage) await settleCall(call, usage);
    else leaveReserved(call, `upstream_${status}`);
    if (status === 529) {
      return fail(
        c,
        529,
        'The model provider is overloaded. Try again later.',
        'overloaded_error',
        'upstream_overloaded',
      );
    }
    return fail(c, 502, `The model provider failed (HTTP ${status}). Try again later.`, 'api_error', 'upstream_error');
  }
  if (usage) await settleCall(call, usage);
  else await releaseCall(call, `upstream_refused_${status}`);
  if (status === 401 || status === 403) {
    return fail(
      c,
      502,
      "The model provider refused Greenhouse's credentials. Ask an administrator to check the model configuration.",
      'api_error',
      'upstream_auth_failed',
    );
  }
  if (status === 429) {
    return fail(
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
  return fail(
    c,
    mapped,
    `The model provider rejected the request: ${message}`,
    upstream.type && /^[a-z_]{1,40}$/.test(upstream.type) ? upstream.type : 'invalid_request_error',
    upstream.code && /^[A-Za-z0-9_.-]{1,60}$/.test(upstream.code) ? upstream.code : 'upstream_rejected',
  );
}

/** Reserve, forward, relay and settle one call. Returns the member's response. */
export async function proxyCall(c: Context, input: ProxyCallInput): Promise<Response> {
  const { fail, key, model } = input;
  const startedAt = Date.now();

  // ── Reserve before any provider I/O ──
  let lease: UserTokenBudgetLease;
  try {
    lease = await reserveUserTokenBudget({
      db: getDb(),
      userId: key.user_id,
      caller: GATEWAY_CALLER,
      estimatedTokens: input.estimate.inputTokens + input.estimate.outputTokens,
      estimatedInputTokens: input.estimate.inputTokens,
      estimatedOutputTokens: input.estimate.outputTokens,
      modelId: model.upstreamModel,
      logicalModelId: model.id,
      providerId: model.provider,
      providerScopeOverride: model.scopeId,
      idempotencyKey: `${GATEWAY_CALLER}:${key.id}:${randomUUID()}`,
      client: 'gateway',
      metadata: {
        gateway_key_id: key.id,
        wire: input.wire,
        logical_model: model.id,
        provider_model: model.upstreamModel,
        stream: input.stream,
      },
    });
  } catch (err) {
    if (err instanceof UsageBudgetAdmissionError) {
      if (err.status === 429) return fail(c, 429, err.message, 'insufficient_quota', 'usage_budget_exceeded');
      return fail(c, err.status, err.message, err.status === 403 ? 'permission_error' : 'api_error', err.code);
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
    response = await fetch(input.url, {
      method: 'POST',
      headers: input.headers,
      body: JSON.stringify(input.body),
      signal: upstream.signal,
    });
  } catch (err) {
    clientSignal?.removeEventListener('abort', onClientGone);
    if (upstream.signal.aborted) {
      leaveReserved(call, 'client_disconnected');
      return fail(c, 499, 'The client closed the request.', 'api_error', 'client_closed');
    }
    if (neverSent(err)) await releaseCall(call, 'upstream_unreachable');
    else leaveReserved(call, 'upstream_fetch_failed');
    logger.warn('[gateway] upstream request failed', { model: model.id, error: toErrorMessage(err) });
    return fail(
      c,
      502,
      'The model provider could not be reached. Try again later.',
      'api_error',
      'upstream_unavailable',
    );
  }

  if (!response.ok) {
    clientSignal?.removeEventListener('abort', onClientGone);
    return track(upstreamFailure(c, input, call, response));
  }

  const isEventStream = (response.headers.get('content-type') ?? '').includes('text/event-stream');
  if (!input.stream || !isEventStream || !response.body) {
    // ── Non-streaming: read the JSON, settle from its usage, pass it through ──
    return track(
      (async () => {
        let text: string;
        try {
          text = await response.text();
        } catch {
          leaveReserved(call, upstream.signal.aborted ? 'client_disconnected' : 'upstream_body_failed');
          return fail(c, 502, 'The model provider response was cut off.', 'api_error', 'upstream_error');
        } finally {
          clientSignal?.removeEventListener('abort', onClientGone);
        }
        const json = parseJson(text);
        if (json === null) {
          leaveReserved(call, 'upstream_invalid_json');
          return fail(
            c,
            502,
            'The model provider returned an unreadable response.',
            'api_error',
            'upstream_invalid_response',
          );
        }
        const usage = input.parseUsage(json);
        if (usage) await settleCall(call, usage);
        else leaveReserved(call, 'usage_missing');
        return c.body(text, 200, { 'content-type': 'application/json' });
      })(),
    );
  }

  // ── Streaming: relay SSE as it arrives, settle from the final usage event ──
  c.header('Content-Type', 'text/event-stream; charset=utf-8');
  c.header('Cache-Control', 'no-cache');
  c.header('X-Accel-Buffering', 'no');
  const relay = new SseUsageRelay(!input.clientWantsUsage, (text) => sanitizeUpstreamText(text, model), input.wire);
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
        else leaveReserved(call, out.aborted || upstream.signal.aborted ? 'client_disconnected' : 'usage_missing');
      })(),
    ),
  );
}
