/**
 * @greenhouse/agent-core — the single agent kernel.
 *
 * One streamText loop, one model registry/resolution path, DSML interception
 * as provider middleware, stream collectors and usage accounting. Every host
 * (API chat route, evaluation, scheduler, and spawned sessions) drives this
 * engine and only adapts protocol/persistence around it.
 *
 * Deliberately database-free: persistence is host-side (see the api's
 * chat-persist.ts).
 */

// Engine
export {
  createChatStreamAsync,
  withFinalAnswerGuarantee,
  createCollectors,
  processStreamPart,
  buildEngineResult,
  summarizeOutput,
  CHAT_STREAM_TIMEOUT,
  FINAL_ANSWER_MAX_ATTEMPTS,
  requiresFinalAnswerGuarantee,
} from './chat-engine.js';
export type { ChatEngineInput, ChatEngineResult, EngineProfile, StreamCollectors } from './chat-engine.js';

// Model layer
export {
  createModelFromConfig,
  buildProviderOptions,
  applyModelOverride,
  resolveModelConfig,
  KIMI_DEFAULT_BASE_URL,
  MINIMAX_DEFAULT_BASE_URL,
  DEFAULT_PROVIDER_MAX_OUTPUT_TOKENS,
} from './model.js';
export type {
  ModelConfig,
  ModelOptions,
  CreateModelOptions,
  ProviderAttemptDescriptor,
  ProviderAttemptHook,
  ProviderAttemptLease,
  ProviderAttemptUsage,
} from './model.js';
export {
  DEFAULT_MODEL_REGISTRY,
  setModelRegistry,
  getModelRegistry,
  getModelEntry,
  getAvailableProviders,
  findModelIdByProviderModel,
  modelSupportsVision,
} from './registry.js';
export type { ProviderEntry, ModelEntry } from './registry.js';

// DSML interception (DeepSeek tool-call leak recovery)
export { createDsmlInterceptor } from './dsml-interceptor.js';
export type { DsmlRecoveryEvent } from './dsml-interceptor.js';

// Cross-host conventions
export { injectTimeContext } from './time-context.js';
export type { EngineMessage, EngineContentPart } from './time-context.js';
export {
  estimateTokens,
  windowMessagesByBudget,
  resolveHistoryBudget,
  HISTORY_TOKEN_BUDGET,
  DEFAULT_COMPACTION_THRESHOLD,
} from './context-budget.js';
export type { HistoryWindowResult } from './context-budget.js';
