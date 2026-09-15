/**
 * Output-token caps the LLM relay enforces per model, in the shape the
 * Mission runner needs so its requests never exceed them.
 *
 * The relay rejects a request whose `max_tokens` is above the model's catalog
 * cap (`options.max_tokens`) instead of clamping it. The coding-agent SDK the
 * runner embeds assumes 16384 for a model declared without `maxTokens`, and
 * the default `flash` entry is capped at 16000 — so a run whose models.json
 * omitted the cap failed on its very first request. The controller hands the
 * caps to the container as GREENHOUSE_MODEL_MAX_TOKENS.
 */
import { getModelEntry } from '@greenhouse/agent-core';

/** What the relay enforces for a model without a catalog cap (routes/llm-relay.ts). */
export const RELAY_DEFAULT_OUTPUT_TOKENS = 20_000;

type CatalogLookup = (id: string) => { options?: { max_tokens?: number } } | undefined;

export function relayOutputLimit(modelId: string, lookup: CatalogLookup = getModelEntry): number {
  const cap = lookup(modelId)?.options?.max_tokens;
  return typeof cap === 'number' && Number.isSafeInteger(cap) && cap > 0 ? cap : RELAY_DEFAULT_OUTPUT_TOKENS;
}

/** `{ [model]: cap }` for every model a run may use (empty ids and repeats dropped). */
export function relayOutputLimits(
  models: ReadonlyArray<string | null | undefined>,
  lookup: CatalogLookup = getModelEntry,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of models) {
    if (id && !(id in out)) out[id] = relayOutputLimit(id, lookup);
  }
  return out;
}
