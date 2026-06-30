/**
 * LLM Service Layer — api-side completion utilities + kernel re-exports.
 *
 * The model factory/registry kernel moved to @greenhouse/agent-core; this
 * index keeps the historical import surface for api/ consumers while the
 * completion layer (complete/completeJson) stays here.
 */

export { createModelFromConfig, buildProviderOptions } from '@greenhouse/agent-core';
export { complete, completeJson } from './complete.js';
export type { CompletionMessage, CompletionOptions, CompletionResult } from './complete.js';
export { getModelEntry, getModelIds, getAvailableProviders } from '@greenhouse/agent-core';
export type { ProviderEntry, ModelEntry } from '@greenhouse/agent-core';
