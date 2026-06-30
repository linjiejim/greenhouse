/**
 * LLM Gateway relay — pure forwarding helpers (中转转发纯逻辑).
 *
 * The gateway exposes a single OpenAI-compatible surface
 * (`POST /api/llm/v1/chat/completions`). Each public model maps to an upstream
 * pool entry; the server rewrites the model id, injects the org's real key and
 * forwards. All passthrough upstreams speak the OpenAI wire format (OpenAI,
 * DeepSeek's OpenAI endpoint, any OpenAI-compatible endpoint). Native protocols
 * (e.g. Anthropic) are not translated.
 *
 * These helpers are intentionally side-effect-free so they can be unit-tested
 * without a DB or network.
 */

import { safeJsonParse } from '@greenhouse/utils/json';
import type { LlmGatewayModelRow, LlmUpstreamKind } from '@greenhouse/db';

/** Upstream kinds the relay can transparently passthrough today (OpenAI wire format). */
export const PASSTHROUGH_KINDS: ReadonlySet<LlmUpstreamKind> = new Set<LlmUpstreamKind>([
  'openai',
  'deepseek',
  'openai-compatible',
]);

export function isPassthroughKind(kind: LlmUpstreamKind): boolean {
  return PASSTHROUGH_KINDS.has(kind);
}

/**
 * Resolve which gateway models a relay key may use.
 *
 * @param allowedModelIds - the key's `meta.allowed_models` (public_id list), or
 *   `null`/empty to mean "the default public subset".
 * @param enabledModels - all currently enabled catalog rows.
 */
export function resolveModelSubset(
  allowedModelIds: string[] | null | undefined,
  enabledModels: LlmGatewayModelRow[],
): LlmGatewayModelRow[] {
  if (allowedModelIds && allowedModelIds.length > 0) {
    const allow = new Set(allowedModelIds);
    return enabledModels.filter((m) => allow.has(m.public_id));
  }
  return enabledModels.filter((m) => m.is_public);
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

/**
 * Build upstream auth + content headers for a passthrough request.
 *
 * All passthrough upstreams use OpenAI-style bearer auth. `kind` is kept for
 * call-site compatibility (and a future native protocol could branch on it).
 */
export function upstreamHeaders(_kind: LlmUpstreamKind, apiKey: string): Record<string, string> {
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

/**
 * Rewrite the client request body for the upstream: swap the public model id for
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

export interface PublicModelEntry {
  id: string;
  display_name: string;
  object: 'model';
  owned_by: 'greenhouse-gateway';
}

/** Shape the `/v1/models` response (OpenAI-compatible) from a model subset. */
export function toModelsListResponse(models: LlmGatewayModelRow[]): {
  object: 'list';
  data: PublicModelEntry[];
} {
  return {
    object: 'list',
    data: models.map((m) => ({
      id: m.public_id,
      display_name: m.display_name,
      object: 'model',
      owned_by: 'greenhouse-gateway',
    })),
  };
}
