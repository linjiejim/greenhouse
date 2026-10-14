/**
 * @greenhouse/agent-core: the agent loop, free of the database and of any vendor. The host
 * resolves the model (key pinning, metering and fallback included) and persists the results.
 */

export {
  prepareLoop,
  runLoop,
  streamLoop,
  withFinalAnswer,
  type LoopInput,
  type LoopRunResult,
  type LoopStepEnd,
  type LoopSettings,
  type LoopStream,
  type PreparedLoop,
} from './loop.js';
export { DEFAULT_MAX_STEPS, LOOP_TIMEOUT, providerOptionsFor, type LoopModel } from './settings.js';
export { FINAL_ANSWER_MAX_ATTEMPTS, type FinalAnswerStreamFactory } from './final-answer.js';
export { collect, createCollector, type LoopCollector, type ToolCallRecord } from './collect.js';
export { createDsmlInterceptor, type DsmlRecoveryEvent } from './dsml-interceptor.js';
export {
  applyTimeContext,
  injectTimeContext,
  type EngineContentPart,
  type EngineMessage,
  type TimeContextOption,
} from './time-context.js';
export {
  chatMaskStub,
  createToolResultMasker,
  resolveInTurnToolBudget,
  toolResultTokens,
  CHAT_IN_TURN_TOOL_TOKEN_BUDGET,
  type ToolResultMaskBatch,
  type ToolResultMaskerOptions,
} from './tool-result-masker.js';
export {
  estimateTokens,
  resolveHistoryBudget,
  windowMessagesByBudget,
  DEFAULT_COMPACTION_THRESHOLD,
  HISTORY_TOKEN_BUDGET,
  type HistoryWindowResult,
} from './context-budget.js';
