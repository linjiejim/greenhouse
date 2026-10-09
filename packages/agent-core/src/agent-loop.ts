/**
 * Agent loop assembly — the ONE place that turns a turn's inputs into AI SDK
 * call settings, shared by every host.
 *
 * Streaming hosts (/api/chat NDJSON, the Bots engine) run these settings
 * through `streamText` (createChatStreamAsync in chat-engine.ts); headless
 * hosts (scheduled tasks, spawn_session, workflow nodes, the Feishu bot) run
 * the very same settings through `generateText` (runAgentLoop below).
 *
 * The two used to be assembled separately and drifted: the headless loop had
 * no DSML interception, no tool-call JSON repair, no final-answer guarantee, no
 * time context and no catalog sampling options, so the same model behaved
 * differently in an automation than in chat. Every loop safeguard lives here
 * now — a host may differ in how it CONSUMES the loop, never in how it runs.
 */

import { generateText, stepCountIs, wrapLanguageModel, NoSuchToolError } from 'ai';
import type { ModelMessage, StopCondition, ToolCallRepairFunction, ToolSet } from 'ai';
import { createDsmlInterceptor, type DsmlRecoveryEvent } from './dsml-interceptor.js';
import { repairJsonArguments } from './repair-tool-json.js';
import {
  createModelFromConfig,
  buildProviderOptions,
  applyModelOverride,
  resolveModelConfig,
  resolvesToDeepSeek,
  type ModelConfig,
  type ProviderAttemptHook,
} from './model.js';
import { applyTimeContext, CHAT_STREAM_TIMEOUT, type EngineProfile, type TimeContextOption } from './loop-shared.js';
import type { EngineMessage } from './time-context.js';
import {
  addUsage,
  emptyUsageTotals,
  finalAnswerParts,
  requiresFinalAnswerGuarantee,
  type FinalAnswerStreamFactory,
  type UsageTotals,
} from './final-answer.js';
import { logger } from '@greenhouse/utils/logger';

export { CHAT_STREAM_TIMEOUT };
export type { EngineProfile, TimeContextOption };

// ─── Input ───────────────────────────────────────────────

export interface AgentLoopInput {
  profile: EngineProfile;
  /**
   * Plain strings for every host except the vision path: user messages may
   * carry multimodal content parts when the catalog marks the model
   * `vision: true` (the api's chat-vision builder is the only producer).
   */
  messages: EngineMessage[];
  tools: Record<string, any>;
  systemPrompt: string;
  sessionId?: string;

  /** Override profile model (e.g. model_override from frontend) */
  modelOverride?: string;
  /** Override profile temperature */
  temperatureOverride?: number;
  /** Override profile max_tokens */
  maxTokensOverride?: number;
  /**
   * External cancellation (server-side stop / graceful shutdown). The SDK
   * surfaces it as an `abort` stream part — same shape as its idle timeout —
   * so streaming hosts handle both through one path.
   */
  abortSignal?: AbortSignal;
  /** Host-owned hard-budget admission at every concrete provider attempt. */
  providerAttemptHook?: ProviderAttemptHook;
  /** Step cap for THIS turn (default: `profile.max_steps ?? 12`). Bots vary it by trigger. */
  maxStepsOverride?: number;
  /**
   * Extra stop conditions OR-ed with the step cap — e.g. a Bots turn ends right
   * after an accepted hand-off or a take-over request.
   */
  extraStopWhen?: StopCondition<ToolSet>[];
  /**
   * Per-step message rewrite, applied before every step (the loop's own
   * last-step `toolChoice:'none'` still applies). Used to mask earlier tool
   * results so a long turn's context stays bounded. Must keep every
   * tool-call/result pair intact and should only change at batch points so the
   * provider prefix cache survives.
   */
  prepareStepMessages?: (args: { stepNumber: number; messages: ModelMessage[] }) => ModelMessage[] | undefined;
  /** Time context for user messages — see TimeContextOption. Default: on. */
  timeContext?: TimeContextOption;
  /**
   * Provider options that replace the catalog-derived ones. Only the headless
   * runner's historical seam passes this; everything else derives them from
   * the resolved model config.
   */
  providerOptionsOverride?: unknown;
}

// ─── Assembly ────────────────────────────────────────────

type GenerateParams = Parameters<typeof generateText>[0];

/** The settings both `streamText` and `generateText` receive, verbatim. */
export interface AgentLoopSettings {
  model: GenerateParams['model'];
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  toolChoice: GenerateParams['toolChoice'];
  stopWhen: GenerateParams['stopWhen'];
  timeout: GenerateParams['timeout'];
  prepareStep: GenerateParams['prepareStep'];
  experimental_repairToolCall: ToolCallRepairFunction<ToolSet>;
  providerOptions?: GenerateParams['providerOptions'];
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

export interface PreparedAgentLoop {
  settings: AgentLoopSettings;
  /** The model config the loop actually runs on (override applied, catalog options folded in). */
  modelConfig: ModelConfig;
  /**
   * Registry id (`flash`, `pro`, …) when the model came from the catalog,
   * otherwise the raw upstream name. Deliberately NOT `modelConfig.model` —
   * that is the *primary* provider's name and does not change when the chain
   * falls through to a backup, so it would claim a provider that never ran.
   */
  modelId: string;
  maxSteps: number;
  /** Filled while the loop runs, whenever the DSML interceptor recovers a leaked call. */
  dsmlRecoveries: DsmlRecoveryEvent[];
  startTime: number;
}

/**
 * Assemble one turn's loop settings. Streaming and headless hosts differ only
 * in the call they make with the result.
 */
export async function prepareAgentLoop(input: AgentLoopInput): Promise<PreparedAgentLoop> {
  const { profile, tools, systemPrompt, modelOverride, temperatureOverride, maxTokensOverride } = input;
  const startTime = Date.now();

  // Model override must go through applyModelOverride — profiles resolve via
  // the registry (`id`), so naively setting `.model` would be silently ignored.
  // resolveModelConfig folds in the catalog's per-model options (thinking,
  // temperature, max_tokens) — the profile no longer carries them, and an
  // override must run on the NEW model's behavior, not the previous one's.
  const modelConfig = resolveModelConfig(
    modelOverride ? applyModelOverride(profile.model, modelOverride) : { ...profile.model },
  );

  const rawModel = await createModelFromConfig(
    modelConfig,
    input.providerAttemptHook ? { onProviderAttempt: input.providerAttemptHook } : {},
  );

  // DSML interceptor for DeepSeek models. Registry-id profiles (the default,
  // e.g. `id: flash`) don't populate `modelConfig.provider`, so a bare
  // `=== 'deepseek'` check silently skipped interception and leaked raw DSML
  // tool-call markup into the answer; resolvesToDeepSeek() looks through the
  // registry entry to the real model.
  const dsmlRecoveries: DsmlRecoveryEvent[] = [];
  const model = resolvesToDeepSeek(modelConfig)
    ? wrapLanguageModel({
        model: rawModel as Parameters<typeof wrapLanguageModel>[0]['model'],
        middleware: createDsmlInterceptor((event) => {
          dsmlRecoveries.push(event);
          logger.warn('[agent-loop] DSML tool call recovered', {
            sessionId: input.sessionId,
            tools: event.toolCalls.map((t) => t.name),
          });
        }),
      })
    : rawModel;

  const providerOptions =
    input.providerOptionsOverride !== undefined ? input.providerOptionsOverride : buildProviderOptions(modelConfig);
  const maxSteps = input.maxStepsOverride ?? profile.max_steps ?? 12;

  // Sampling params: request override wins, then the catalog/profile options.
  // AI SDK v6 names the output cap `maxOutputTokens` — the old `maxTokens`
  // spread was silently dropped.
  const temperature = temperatureOverride ?? modelConfig.options?.temperature;
  const maxOutputTokens = maxTokensOverride ?? modelConfig.options?.max_tokens;

  const settings: AgentLoopSettings = {
    model,
    system: systemPrompt,
    messages: applyTimeContext(input.messages, input.timeContext),
    tools: tools as ToolSet,
    experimental_repairToolCall: createToolCallRepair(input.sessionId),
    stopWhen: input.extraStopWhen?.length ? [stepCountIs(maxSteps), ...input.extraStopWhen] : stepCountIs(maxSteps),
    timeout: CHAT_STREAM_TIMEOUT,
    toolChoice: (profile.tool_choice ?? 'auto') as GenerateParams['toolChoice'],
    // Force a final text answer on the last step so the run never ends
    // mid-tool-call; a host's message rewrite rides along on every step.
    prepareStep: ({ stepNumber, messages: stepMessages }: { stepNumber: number; messages: ModelMessage[] }) => {
      const rewritten = input.prepareStepMessages?.({ stepNumber, messages: stepMessages });
      if (stepNumber === maxSteps - 1) {
        return { toolChoice: 'none' as const, ...(rewritten ? { messages: rewritten } : {}) };
      }
      return rewritten ? { messages: rewritten } : {};
    },
    ...(providerOptions ? { providerOptions: providerOptions as GenerateParams['providerOptions'] } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  };

  return {
    settings,
    modelConfig,
    modelId: modelConfig.id ?? modelConfig.model,
    maxSteps,
    dsmlRecoveries,
    startTime,
  };
}

/**
 * Last chance for a tool call whose arguments would not parse.
 *
 * A malformed argument string otherwise discards the whole call, and the model
 * does not reliably recover: on dev, three consecutive `workflow_plan` drafts
 * broke this way and the model abandoned orchestration entirely rather than
 * retrying a fourth time. The repair is local and deterministic (see
 * `repair-tool-json.ts`); a wrong TOOL NAME is not repairable here and is left
 * to fail, since guessing which tool was meant is a different and worse bet.
 *
 * Repairs are logged: a model that needs this often is telling us its tool
 * schema is too big or its description too vague, and that belongs in the
 * friction queue rather than being silently absorbed.
 */
function createToolCallRepair(sessionId?: string): ToolCallRepairFunction<ToolSet> {
  return async ({ toolCall, error }) => {
    if (NoSuchToolError.isInstance(error)) return null;

    const repaired = repairJsonArguments(toolCall.input);
    if (repaired === null || repaired === toolCall.input) {
      logger.warn('[agent-loop] tool call arguments could not be repaired', {
        sessionId,
        tool: toolCall.toolName,
        bytes: toolCall.input?.length,
      });
      return null;
    }

    logger.warn('[agent-loop] repaired malformed tool call arguments', {
      sessionId,
      tool: toolCall.toolName,
      bytes: toolCall.input.length,
    });
    return { ...toolCall, input: repaired };
  };
}

// ─── Headless run ────────────────────────────────────────

type GenerateResult = Awaited<ReturnType<typeof generateText>>;

export interface AgentLoopRunResult {
  text: string;
  finishReason: GenerateResult['finishReason'];
  /** Every provider call of the turn, the final-answer fallback included. */
  usage: UsageTotals;
  steps: GenerateResult['steps'];
  responseMessages: ModelMessage[];
  modelId: string;
  dsmlRecoveries: DsmlRecoveryEvent[];
  /** True when the loop ended with tools run but no text and the fallback had to answer. */
  finalAnswerRecovered: boolean;
  durationMs: number;
}

export interface RunAgentLoopOptions {
  /** Deterministic provider seam for the fallback (tests). */
  finalAnswerStreamFactory?: FinalAnswerStreamFactory;
}

/**
 * Run one turn to completion without streaming — the headless host of the
 * shared assembly. Same model, interceptor, repair, stop/timeout bounds,
 * forced final step and time context as chat; and the same DeepSeek
 * final-answer guarantee, collected instead of streamed.
 */
export async function runAgentLoop(
  input: AgentLoopInput,
  options: RunAgentLoopOptions = {},
): Promise<AgentLoopRunResult> {
  const prepared = await prepareAgentLoop(input);
  const result = await generateText(prepared.settings);

  const usage = emptyUsageTotals();
  // totalUsage spans every step of the loop; `usage` is only the final step.
  addUsage(usage, result.totalUsage ?? result.usage);

  let text = result.text ?? '';
  let finalAnswerRecovered = false;
  const toolRan = result.steps.some((step) => (step.toolResults?.length ?? 0) > 0);
  // generateText throws on abort, so reaching here means the loop ended on its
  // own; an empty answer after tool use is the DeepSeek failure mode.
  if (!text.trim() && toolRan && requiresFinalAnswerGuarantee(prepared.modelConfig)) {
    for await (const part of finalAnswerParts(
      {
        profile: { ...input.profile, model: prepared.modelConfig },
        systemPrompt: input.systemPrompt,
        baseMessages: input.messages,
        gatheredMessages: result.response.messages,
        ...(input.providerAttemptHook ? { providerAttemptHook: input.providerAttemptHook } : {}),
        ...(input.timeContext !== undefined ? { timeContext: input.timeContext } : {}),
      },
      (extra) => addUsage(usage, extra),
      undefined,
      options.finalAnswerStreamFactory,
    )) {
      text += part.text;
    }
    finalAnswerRecovered = text.trim().length > 0;
    logger.warn('[agent-loop] headless turn ended without text after tool use — final-answer fallback ran', {
      sessionId: input.sessionId,
      recovered: finalAnswerRecovered,
    });
  }

  return {
    text,
    finishReason: result.finishReason,
    usage,
    steps: result.steps,
    responseMessages: result.response.messages,
    modelId: prepared.modelId,
    dsmlRecoveries: prepared.dsmlRecoveries,
    finalAnswerRecovered,
    durationMs: Date.now() - prepared.startTime,
  };
}
