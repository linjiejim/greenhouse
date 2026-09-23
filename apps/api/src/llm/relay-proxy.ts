/**
 * LLM Gateway relay — pure forwarding helpers (中转转发纯逻辑).
 *
 * The gateway exposes a single OpenAI-compatible surface
 * (`POST /api/llm/v1/chat/completions`). A client-facing model id is a model in
 * `config/models.yaml`; the server picks the first provider in that model's
 * chain whose API key env var is set, rewrites the model id and forwards.
 * OpenAI / DeepSeek / OpenAI-compatible upstreams are a transparent passthrough.
 *
 * The catalog used to live in `llm_upstreams` + `llm_gateway_models` with the
 * vendor key encrypted in the DB; both are gone — one config, keys in env.
 *
 * These helpers are side-effect-free apart from reading `process.env`, so they
 * unit-test without a DB or network.
 */

import { safeJsonParse } from '@greenhouse/utils/json';
import type { ModelEntry } from '@greenhouse/agent-core';

/** Provider kinds the relay can transparently passthrough today (OpenAI wire format). */
export const PASSTHROUGH_KINDS: ReadonlySet<string> = new Set(['openai', 'deepseek', 'openai-compatible']);

export function isPassthroughKind(kind: string): boolean {
  return PASSTHROUGH_KINDS.has(kind);
}

/** A catalog model resolved down to one reachable upstream. */
export interface RelayModel {
  /** Client-facing model id — the catalog key. */
  id: string;
  displayName: string;
  provider: string;
  /** The model id actually sent upstream. */
  upstreamModel: string;
  baseUrl: string;
  apiKey: string;
  /** Exact hard-budget account for the credential that receives this request. */
  scopeId: string;
}

/**
 * One relay HTTP request is always one provider attempt: this endpoint has no
 * response cache, so a repeated client Idempotency-Key must never deduplicate
 * hard-budget charging. Keep that client key only as permanent diagnostic
 * metadata and identify the billable attempt with a server-generated nonce.
 */
export function buildRelayBudgetAttempt(
  clientId: string,
  clientIdempotencyKey: string | undefined,
  attemptNonce: string,
): {
  idempotencyKey: string;
  metadata: { client_idempotency_key?: string };
} {
  return {
    idempotencyKey: `relay:${clientId}:${attemptNonce}`,
    metadata: clientIdempotencyKey ? { client_idempotency_key: clientIdempotencyKey } : {},
  };
}

/** Mirrors createModelDirect's default so relay and agent hit the same endpoint. */
function resolveBaseUrl(provider: string, declared: string | undefined, env: NodeJS.ProcessEnv): string | null {
  if (declared) return declared;
  if (provider === 'deepseek') return env.LLM_BASE_URL || 'https://api.deepseek.com';
  if (provider === 'openai') return 'https://api.openai.com/v1';
  return env.LLM_BASE_URL || null;
}

/**
 * Resolve a catalog model to its first usable upstream: passthrough protocol,
 * API key present in env, base URL known. Returns null when nothing in the
 * chain is reachable — the relay reports that as "temporarily unavailable"
 * rather than pretending the model exists.
 */
export function resolveRelayModel(
  id: string,
  entry: ModelEntry,
  env: NodeJS.ProcessEnv = process.env,
): RelayModel | null {
  for (const provider of entry.providers) {
    if (!isPassthroughKind(provider.provider)) continue;
    const apiKey = env[provider.apiKeyEnv];
    if (!apiKey) continue;
    const baseUrl = resolveBaseUrl(provider.provider, provider.baseUrl, env);
    if (!baseUrl) continue;
    return {
      id,
      displayName: entry.name,
      provider: provider.provider,
      upstreamModel: provider.model,
      baseUrl,
      apiKey,
      scopeId: `${provider.apiKeyEnv}:${provider.provider}:${provider.baseUrl ?? 'default'}`,
    };
  }
  return null;
}

/**
 * Which catalog models a relay key may use: its explicit `meta.allowed_models`
 * subset, else the config's `relay.public` list.
 */
export function resolveModelSubset(
  allowedModelIds: string[] | null | undefined,
  catalogIds: string[],
  publicIds: string[],
): string[] {
  if (allowedModelIds && allowedModelIds.length > 0) {
    const allow = new Set(allowedModelIds);
    return catalogIds.filter((id) => allow.has(id));
  }
  const isPublic = new Set(publicIds);
  return catalogIds.filter((id) => isPublic.has(id));
}

/** Read `meta.allowed_models` from an api_clients.meta JSON string. */
export function parseAllowedModels(metaJson: string | null | undefined): string[] | null {
  if (!metaJson) return null;
  const meta = safeJsonParse(metaJson, {}) as { allowed_models?: unknown };
  const list = meta?.allowed_models;
  if (Array.isArray(list)) return list.filter((x): x is string => typeof x === 'string');
  return null;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Upstream chat-completions URL. `base_url` should already include `/v1` if the upstream needs it. */
export function upstreamChatUrl(baseUrl: string): string {
  return joinUrl(baseUrl.trim(), 'chat/completions');
}

/** Build upstream auth + content headers for a passthrough request. */
export function upstreamHeaders(kind: string, apiKey: string): Record<string, string> {
  if (!isPassthroughKind(kind)) throw new Error(`Unsupported upstream protocol: ${kind}`);
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
}

export interface IncomingChatBody {
  model?: string;
  messages?: unknown;
  stream?: boolean;
  stream_options?: { include_usage?: boolean } & Record<string, unknown>;
  [key: string]: unknown;
}

export class RelayRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayRequestError';
  }
}

/**
 * Validate and materialize a provider-enforced output ceiling. The catalog
 * value is a hard server boundary; clients cannot raise it by choosing either
 * OpenAI spelling of the field.
 */
export function applyRelayOutputLimit(
  body: IncomingChatBody,
  maxOutputTokens: number,
): { body: IncomingChatBody; outputTokenLimit: number } {
  const cap = Math.max(1, Math.floor(maxOutputTokens));
  if (body.max_completion_tokens !== undefined && body.max_tokens !== undefined) {
    throw new RelayRequestError('Use either max_tokens or max_completion_tokens, not both');
  }
  const declared = [body.max_completion_tokens, body.max_tokens].filter((value) => value !== undefined);
  for (const value of declared) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new RelayRequestError('max_tokens must be a positive integer');
    }
    if (value > cap) {
      throw new RelayRequestError(`Requested output limit exceeds the model maximum of ${cap} tokens`);
    }
  }

  if (body.max_completion_tokens !== undefined) {
    return {
      body: { ...body, max_completion_tokens: body.max_completion_tokens },
      outputTokenLimit: body.max_completion_tokens as number,
    };
  }
  if (body.max_tokens !== undefined) {
    return { body: { ...body, max_tokens: body.max_tokens }, outputTokenLimit: body.max_tokens as number };
  }
  return { body: { ...body, max_tokens: cap }, outputTokenLimit: cap };
}

/**
 * Rewrite the client request body for the upstream: swap the client-facing model id for
 * the real upstream model, and (for streaming) force `stream_options.include_usage`
 * so the relay can always read token usage from the final SSE chunk.
 */
export function buildUpstreamBody(body: IncomingChatBody, upstreamModel: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body, model: upstreamModel };
  if (body.stream) {
    out.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
  }
  return out;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

interface OpenAiUsageShape {
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/** Extract token usage from a non-streaming OpenAI JSON response. */
export function extractUsageFromJson(json: unknown): TokenUsage {
  const usage = (json as OpenAiUsageShape)?.usage;
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  };
}

/**
 * Extract token usage from a single SSE `data:` line of a streamed OpenAI
 * response. Returns `null` for lines without a usage payload (`[DONE]`, deltas).
 */
export function extractUsageFromSseChunk(line: string): TokenUsage | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice('data:'.length).trim();
  if (!payload || payload === '[DONE]') return null;
  const json = safeJsonParse(payload, null) as OpenAiUsageShape | null;
  if (!json?.usage) return null;
  return {
    inputTokens: json.usage.prompt_tokens ?? 0,
    outputTokens: json.usage.completion_tokens ?? 0,
  };
}

export interface ClientModelEntry {
  id: string;
  display_name: string;
  object: 'model';
  owned_by: 'greenhouse-gateway';
}

/** Shape the `/v1/models` response (OpenAI-compatible) from a model subset. */
export function toModelsListResponse(models: RelayModel[]): {
  object: 'list';
  data: ClientModelEntry[];
} {
  return {
    object: 'list',
    data: models.map((m) => ({
      id: m.id,
      display_name: m.displayName,
      object: 'model',
      owned_by: 'greenhouse-gateway',
    })),
  };
}
