/**
 * The provider block the runner hands the coding-agent SDK (`models.json`).
 *
 * Every model the API named carries an explicit `maxTokens`: the SDK assumes
 * 16384 for a model declared without one, and the relay rejects any request
 * whose `max_tokens` exceeds the model's catalog cap (16000 for the default
 * `flash`) instead of clamping — the first request of a run would 400. The
 * API passes the caps as GREENHOUSE_MODEL_MAX_TOKENS, a JSON object.
 */

export function parseModelMaxTokens(raw: string | undefined): Record<string, number> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) out[id] = value;
  }
  return out;
}

export interface RelayModelsConfigInput {
  providerId: string;
  apiBase: string;
  model: string;
  fallbackModel: string | null;
  maxTokens: Record<string, number>;
}

export function buildRelayModelsConfig(input: RelayModelsConfigInput) {
  const models = [
    input.model,
    ...(input.fallbackModel && input.fallbackModel !== input.model ? [input.fallbackModel] : []),
  ];
  return {
    providers: {
      [input.providerId]: {
        name: 'Greenhouse LLM Relay',
        baseUrl: `${input.apiBase}/api/llm/v1`,
        api: 'openai-completions',
        apiKey: '$GREENHOUSE_RELAY_KEY',
        // The relay fronts DeepSeek / OpenAI-compatible upstreams: no
        // `developer` role, and no reasoning-effort knob on the wire.
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: models.map((id) => ({
          id,
          name: id,
          ...(input.maxTokens[id] ? { maxTokens: input.maxTokens[id] } : {}),
        })),
      },
    },
  };
}
