/**
 * @greenhouse/agent-core — the single agent kernel.
 *
 * One loop assembly (agent-loop.ts) with every safeguard — DSML interception
 * as provider middleware, tool-call JSON repair, time context, step/timeout
 * bounds, the forced final step, the DeepSeek final-answer guarantee — run
 * either streaming (createChatStreamAsync: /api/chat, Bots) or headless
 * (runAgentLoop: scheduler, spawn_session, workflow nodes, Feishu). Plus one
 * model registry/resolution path, stream collectors and usage accounting.
 * Hosts only adapt protocol/persistence around it.
 *
 * Deliberately database-free: persistence is host-side (see the api's
 * chat-persist.ts).
 */

// Loop assembly (shared by every host)
export { prepareAgentLoop, runAgentLoop } from './agent-loop.js';
export type {
  AgentLoopInput,
  AgentLoopSettings,
  AgentLoopRunResult,
  PreparedAgentLoop,
  RunAgentLoopOptions,
  TimeContextOption,
} from './agent-loop.js';

// Streaming host
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
export type {
  AgentStreamResult,
  ChatEngineInput,
  ChatEngineResult,
  EngineProfile,
  StreamCollectors,
} from './chat-engine.js';
export { usageTotalsFrom } from './loop-shared.js';
export type { UsageTotals } from './loop-shared.js';

// Model layer
export {
  createModelFromConfig,
  buildProviderOptions,
  applyModelOverride,
  resolveModelConfig,
  hasCheapPromptCache,
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
  createToolResultMasker,
  chatMaskStub,
  resolveInTurnToolBudget,
  toolResultTokens,
  CHAT_IN_TURN_TOOL_TOKEN_BUDGET,
} from './tool-result-masker.js';
export type { ToolResultMaskerOptions, ToolResultMaskBatch } from './tool-result-masker.js';
export {
  estimateTokens,
  windowMessagesByBudget,
  resolveHistoryBudget,
  HISTORY_TOKEN_BUDGET,
  DEFAULT_COMPACTION_THRESHOLD,
} from './context-budget.js';
export type { HistoryWindowResult } from './context-budget.js';
