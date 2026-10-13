/**
 * What the loop needs to know about a model, and the settings every call shares. The model
 * arrives resolved by the host (the API's providers service): key pinning, usage metering and
 * fallback across instances are already wrapped around it.
 */

import { wrapLanguageModel, type LanguageModel } from 'ai';
import { createDsmlInterceptor, type DsmlRecoveryEvent } from './dsml-interceptor.js';

export interface LoopModel {
  model: LanguageModel;
  /** The model the chain starts with, for logs. */
  modelId: string;
  /** DeepSeek gets the DSML interceptor and the final-answer guarantee. */
  deepseek?: boolean;
  /** Reasoning on or off where the vendor has a switch (DeepSeek); unset keeps the vendor default. */
  thinking?: boolean;
}

export const DEFAULT_MAX_STEPS = 12;

/**
 * Bounds for every turn. `stepMs` covers a whole step including local tool execution, so it
 * stays above slow tools (image generation takes 30–100 s); `firstChunkMs` and `chunkMs` bound
 * silence while streaming; `totalMs` keeps a multi-step loop from living forever.
 */
export const LOOP_TIMEOUT = {
  totalMs: 15 * 60_000,
  stepMs: 4 * 60_000,
  firstChunkMs: 2 * 60_000,
  chunkMs: 2 * 60_000,
} as const;

/** DeepSeek's thinking switch rides in its own provider options; nothing else needs any. */
export function providerOptionsFor(model: LoopModel, thinking = model.thinking) {
  if (!model.deepseek || thinking === undefined) return undefined;
  return { deepseek: { thinking: { type: thinking ? 'enabled' : 'disabled' } } } as const;
}

/** DeepSeek sometimes writes a tool call as DSML markup in its text; the interceptor turns it back into a call. */
export function guardedModel(model: LoopModel, onRecovered?: (event: DsmlRecoveryEvent) => void): LanguageModel {
  if (!model.deepseek) return model.model;
  return wrapLanguageModel({
    model: model.model as Parameters<typeof wrapLanguageModel>[0]['model'],
    middleware: createDsmlInterceptor(onRecovered),
  });
}
