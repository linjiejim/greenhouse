/**
 * @greenhouse/agent-core — the single agent kernel.
 *
 * One streamText loop, one model registry/resolution path, stream collectors
 * and usage accounting. Every host (api chat route, v1 OpenAI-compatible route,
 * eval, scheduler) drives this engine and only adapts protocol/persistence
 * around it.
 *
 * Deliberately database-free: persistence is host-side (see the api's
 * chat-persist.ts).
 */

// Engine
export {
  createChatStreamAsync,
  createCollectors,
  processStreamPart,
  buildEngineResult,
  summarizeOutput,
} from './chat-engine.js';
export type { ChatEngineInput, ChatEngineResult, EngineProfile, StreamCollectors } from './chat-engine.js';

// Model layer
export { createModelFromConfig, buildProviderOptions, applyModelOverride, resolveModelChoice } from './model.js';
export type { ModelConfig, ModelOptions, ModelChoice } from './model.js';
export { getModelEntry, getModelIds, getAvailableProviders, findModelIdByProviderModel } from './registry.js';
export type { ProviderEntry, ModelEntry } from './registry.js';

// Fork extension seams — re-add native providers / per-tool summaries downstream
// without editing this package (registries are empty upstream).
export {
  registerProviderFactory,
  registerProviderOptionsBuilder,
  registerProviderMiddleware,
  listRegisteredProviders,
} from './provider-extensions.js';
export type { ProviderFactory, ProviderFactoryArgs, ProviderOptionsBuilder } from './provider-extensions.js';
export { registerToolOutputSummarizer } from './tool-stream-hooks.js';
export type { ToolOutputSummarizer } from './tool-stream-hooks.js';

// Cross-host conventions
export { injectTimeContext } from './time-context.js';
export { createLocalMarker, isLocalToolMarker } from './local-tool-marker.js';
export type { LocalToolMarker } from './local-tool-marker.js';
