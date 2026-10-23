/**
 * Model gateway — the pure half: which upstream a catalog model goes to, what
 * the forwarded request looks like, how usage is read back, and what an
 * upstream error may say to the member.
 *
 * Only OpenAI-wire upstreams pass through (`openai`, `deepseek`,
 * `openai-compatible` in models.yaml); a model whose providers are all
 * something else is simply not offered. The first provider in the model's
 * chain whose key env var is set (and whose base URL is known) is used — there
 * is no fallback to the next provider mid-request.
 *
 * Side-effect free apart from reading `process.env`, so it unit-tests without a
 * database or network.
 */

import { estimateTokens, type ModelEntry } from '@greenhouse/agent-core';

/** Provider kinds the gateway forwards as-is (OpenAI Chat Completions wire format). */
export const PASSTHROUGH_KINDS: ReadonlySet<string> = new Set(['openai', 'deepseek', 'openai-compatible']);

/** Reserved output when neither the request nor the catalog bounds it. */
export const DEFAULT_GATEWAY_OUTPUT_TOKENS = 16_000;
/** Output can never exceed the context window; used when the catalog declares none. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Headroom over the tokenizer approximation (same margin as the chat provider hook). */
const INPUT_ESTIMATE_MARGIN = 1.25;
/** Images are priced by the provider per image, not per base64 character. */
const IMAGE_TOKEN_ALLOWANCE = 1_500;
const MAX_CHOICES = 16;

/** A catalog model resolved down to the one upstream that serves it. */
export interface GatewayModel {
  /** Catalog id — what the member's agent sends as `model`. */
  id: string;
  name: string;
  provider: string;
  /** The model name sent upstream. */
  upstreamModel: string;
  baseUrl: string;
  apiKey: string;
  /** Hard-budget scope of the credential that receives the call (as the chat runtime names it). */
  scopeId: string;
  contextWindow: number | null;
  maxTokens: number | null;
}

/** Mirrors the model factory's defaults so the gateway and the agent hit the same endpoint. */
function resolveBaseUrl(provider: string, declared: string | undefined, env: NodeJS.ProcessEnv): string | null {
  if (declared) return declared;
  if (provider === 'deepseek') return env.LLM_BASE_URL || 'https://api.deepseek.com';
  if (provider === 'openai') return 'https://api.openai.com/v1';
  return env.LLM_BASE_URL || null;
}

/** The first usable upstream of a catalog model, or null when none is (key unset, not OpenAI-wire, no URL). */
export function resolveGatewayModel(
  id: string,
  entry: ModelEntry,
  env: NodeJS.ProcessEnv = process.env,
): GatewayModel | null {
  for (const provider of entry.providers) {
    if (!PASSTHROUGH_KINDS.has(provider.provider)) continue;
    const apiKey = env[provider.apiKeyEnv];
    if (!apiKey) continue;
    const baseUrl = resolveBaseUrl(provider.provider, provider.baseUrl, env);
    if (!baseUrl) continue;
    const maxTokens = entry.options?.max_tokens;
    return {
      id,
      name: entry.name,
      provider: provider.provider,
      upstreamModel: provider.model,
      baseUrl,
      apiKey,
      scopeId: `${provider.apiKeyEnv}:${provider.provider}:${provider.baseUrl ?? 'default'}`,
      contextWindow: entry.contextWindow ?? null,
      maxTokens: typeof maxTokens === 'number' && maxTokens > 0 ? Math.floor(maxTokens) : null,
    };
  }
  return null;
}

/** Every catalog model the gateway can serve, narrowed to a key's allow-list (null = all). */
export function listGatewayModels(
  models: Readonly<Record<string, ModelEntry>>,
  allowed: readonly string[] | null,
  env: NodeJS.ProcessEnv = process.env,
): GatewayModel[] {
  const allow = allowed ? new Set(allowed) : null;
  return Object.entries(models)
    .filter(([id]) => !allow || allow.has(id))
    .map(([id, entry]) => resolveGatewayModel(id, entry, env))
    .filter((model): model is GatewayModel => model !== null);
}

export function upstreamChatUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
}

/** Only these go upstream — never anything the member's client sent (its Authorization above all). */
export function upstreamHeaders(apiKey: string, stream: boolean): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
}

export type ChatRequestBody = Record<string, unknown> & {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  stream_options?: unknown;
};

export class GatewayRequestError extends Error {
  constructor(
    message: string,
    public readonly param: string | null = null,
  ) {
    super(message);
    this.name = 'GatewayRequestError';
  }
}

export interface ValidatedChatRequest {
  model: string;
  stream: boolean;
  /** The client asked for the usage chunk itself (`stream_options.include_usage`). */
  clientWantsUsage: boolean;
  /** max_completion_tokens ?? max_tokens, when given. */
  requestedOutputTokens: number | null;
  choices: number;
}

function positiveInteger(value: unknown, param: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new GatewayRequestError(`${param} must be a positive integer`, param);
  }
  return value;
}

/** The few fields the gateway itself relies on; everything else passes through untouched. */
export function validateChatRequest(body: ChatRequestBody): ValidatedChatRequest {
  if (typeof body.model !== 'string' || !body.model.trim()) {
    throw new GatewayRequestError('model is required: one of the ids GET /models lists', 'model');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new GatewayRequestError('messages must be a non-empty array', 'messages');
  }
  if (body.stream !== undefined && body.stream !== null && typeof body.stream !== 'boolean') {
    throw new GatewayRequestError('stream must be a boolean', 'stream');
  }
  if (body.max_tokens !== undefined && body.max_tokens !== null) positiveInteger(body.max_tokens, 'max_tokens');
  if (body.max_completion_tokens !== undefined && body.max_completion_tokens !== null) {
    positiveInteger(body.max_completion_tokens, 'max_completion_tokens');
  }
  const choices = body.n === undefined || body.n === null ? 1 : positiveInteger(body.n, 'n');
  if (choices > MAX_CHOICES) throw new GatewayRequestError(`n may be at most ${MAX_CHOICES}`, 'n');
  const options = body.stream_options;
  const clientWantsUsage =
    !!options && typeof options === 'object' && (options as { include_usage?: unknown }).include_usage === true;
  const requested = (body.max_completion_tokens ?? body.max_tokens) as number | null | undefined;
  return {
    model: body.model.trim(),
    stream: body.stream === true,
    clientWantsUsage,
    requestedOutputTokens: requested ?? null,
    choices,
  };
}

/**
 * The body sent upstream: the member's request with the upstream model name,
 * and — when streaming — `stream_options.include_usage` forced on so the final
 * chunk always reports usage. Tools, response_format and the rest pass through.
 */
export function buildUpstreamBody(body: ChatRequestBody, upstreamModel: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body, model: upstreamModel };
  if (body.stream === true) {
    const options =
      body.stream_options && typeof body.stream_options === 'object'
        ? (body.stream_options as Record<string, unknown>)
        : {};
    out.stream_options = { ...options, include_usage: true };
  }
  return out;
}

/**
 * The reservation for one call: input estimated from the prompt (inline images
 * counted per image, not per base64 character, with the usual margin), output
 * from the request's own cap, else the catalog's, never above the context
 * window, times `n`. Actual usage replaces it at settlement.
 */
export function estimateCallTokens(
  body: ChatRequestBody,
  request: Pick<ValidatedChatRequest, 'requestedOutputTokens' | 'choices'>,
  model: Pick<GatewayModel, 'contextWindow' | 'maxTokens'>,
): { inputTokens: number; outputTokens: number } {
  let images = 0;
  const serialized =
    JSON.stringify(
      {
        messages: body.messages,
        tools: body.tools ?? null,
        functions: body.functions ?? null,
        response_format: body.response_format ?? null,
      },
      (_key, value: unknown) => {
        if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'image_url') images++;
        if (typeof value === 'string' && value.startsWith('data:') && value.length > 256) return '';
        return value;
      },
    ) ?? '';
  const inputTokens = Math.max(
    1,
    Math.ceil(estimateTokens(serialized) * INPUT_ESTIMATE_MARGIN) + images * IMAGE_TOKEN_ALLOWANCE,
  );
  const window = model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const perChoice = Math.min(request.requestedOutputTokens ?? model.maxTokens ?? DEFAULT_GATEWAY_OUTPUT_TOKENS, window);
  return { inputTokens, outputTokens: Math.max(1, perChoice * request.choices) };
}

export interface GatewayUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/** OpenAI `usage` (with DeepSeek's cache-hit spelling), or null when the object carries none. */
export function parseUsage(json: unknown): GatewayUsage | null {
  const usage = (json as { usage?: unknown } | null)?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const inputTokens = count(u.prompt_tokens);
  const outputTokens = count(u.completion_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return null;
  const promptDetails = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const completionDetails = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cachedTokens: count(promptDetails.cached_tokens) ?? count(u.prompt_cache_hit_tokens) ?? 0,
    reasoningTokens: count(completionDetails.reasoning_tokens) ?? 0,
  };
}

/**
 * Relays an upstream SSE stream event by event, as each one completes, and
 * remembers the last usage it saw. The gateway forces `include_usage`
 * upstream; when the member's client did not ask for it, the usage-only chunk
 * (empty `choices`) is dropped so the client sees exactly the stream it asked for.
 */
export class SseUsageRelay {
  private buffer = '';
  usage: GatewayUsage | null = null;
  sawDone = false;

  constructor(
    private readonly dropUsageOnlyChunks: boolean,
    /** Rewrites the text of an in-stream error event (upstream error text never reaches the member raw). */
    private readonly sanitize: (text: string) => string = (text) => text,
  ) {}

  /** Feed decoded text; returns the complete events to forward now. */
  push(text: string): string {
    this.buffer += text;
    let out = '';
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(this.buffer);
      if (!boundary) break;
      const end = boundary.index + boundary[0].length;
      out += this.relay(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end);
    }
    return out;
  }

  /** Whatever is left when the upstream closes (an unterminated last event). */
  flush(): string {
    const rest = this.buffer;
    this.buffer = '';
    return rest ? this.relay(rest) : '';
  }

  private relay(event: string): string {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''));
    if (data.length === 0) return event;
    const payload = data.join('\n').trim();
    if (payload === '[DONE]') {
      this.sawDone = true;
      return event;
    }
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return event;
    }
    const error = (json as { error?: unknown } | null)?.error;
    if (error !== undefined && error !== null) {
      const upstream = readUpstreamError(JSON.stringify(json));
      const message = this.sanitize(upstream.message ?? 'The model provider reported an error.');
      return `data: ${JSON.stringify({ error: { message, type: upstream.type ?? 'api_error', code: upstream.code } })}\n\n`;
    }
    const usage = parseUsage(json);
    if (!usage) return event;
    this.usage = usage;
    const choices = (json as { choices?: unknown }).choices;
    if (this.dropUsageOnlyChunks && Array.isArray(choices) && choices.length === 0) return '';
    return event;
  }
}

/**
 * An upstream's own error text, safe to show the member: the upstream key, its
 * base URL and host, any URL, bearer token or key-looking string redacted, and
 * cut to a sane length.
 */
export function sanitizeUpstreamText(text: string, model: Pick<GatewayModel, 'apiKey' | 'baseUrl'>): string {
  let out = text;
  const secrets = [model.apiKey, model.baseUrl.replace(/\/+$/, '')];
  try {
    secrets.push(new URL(model.baseUrl).host);
  } catch {
    // Not a URL — nothing more to redact.
  }
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  out = out
    .replace(/https?:\/\/[^\s"'<>)]+/gi, '[url]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk|rk|ak|ghgw)[-_][A-Za-z0-9_*.-]{6,}/g, '[redacted]');
  return out.length > 500 ? `${out.slice(0, 500)}…` : out;
}

/** The message / type / code of an upstream error body, when it has the OpenAI shape. */
export function readUpstreamError(text: string): { message: string | null; type: string | null; code: string | null } {
  try {
    const json = JSON.parse(text) as { error?: unknown; message?: unknown };
    const error = (json.error && typeof json.error === 'object' ? json.error : json) as Record<string, unknown>;
    const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
    return {
      message: str(error.message) ?? str(json.error),
      type: str(error.type),
      code: str(error.code) ?? (typeof error.code === 'number' ? String(error.code) : null),
    };
  } catch {
    return { message: text.trim() ? text.trim() : null, type: null, code: null };
  }
}
