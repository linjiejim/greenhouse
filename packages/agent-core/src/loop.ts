/**
 * The agent loop: the one place that turns a turn's inputs into AI SDK call settings, consumed
 * streaming (streamLoop) or headless (runLoop). Every safeguard lives here, so a turn behaves
 * the same whichever way it runs: tool-call JSON repair, a step cap with a forced text-only last
 * step, stream timeouts, time context, and for DeepSeek the DSML interceptor and the
 * final-answer guarantee.
 */

import { generateText, isStepCount, NoSuchToolError, streamText } from 'ai';
import type { ModelMessage, StopCondition, ToolCallRepairFunction, ToolSet } from 'ai';
import { logger } from '@greenhouse/utils/logger';
import type { DsmlRecoveryEvent } from './dsml-interceptor.js';
import { finalAnswerParts, type FinalAnswerStreamFactory } from './final-answer.js';
import { repairJsonArguments } from './repair-tool-json.js';
import { DEFAULT_MAX_STEPS, guardedModel, LOOP_TIMEOUT, providerOptionsFor, type LoopModel } from './settings.js';
import { applyTimeContext, type EngineMessage, type TimeContextOption } from './time-context.js';

export interface LoopInput {
  model: LoopModel;
  instructions: string;
  /** Plain strings, except user messages that carry image parts for a vision model. */
  messages: EngineMessage[];
  tools?: ToolSet;
  /** Default DEFAULT_MAX_STEPS; the last step is always text only. */
  maxSteps?: number;
  /** Stop, shutdown or a deadline; the SDK reports it as an `abort` part. */
  abortSignal?: AbortSignal;
  /** Extra stop conditions OR-ed with the step cap (a hand-off, a request that needs a person). */
  stopWhen?: StopCondition<ToolSet>[];
  /**
   * Rewrites the messages before each step, e.g. masking old tool results to bound a long
   * turn. Must keep tool-call and tool-result pairs intact.
   */
  prepareStepMessages?: (args: { stepNumber: number; messages: ModelMessage[] }) => ModelMessage[] | undefined;
  /** Default on. */
  timeContext?: TimeContextOption;
  maxOutputTokens?: number;
  /** Correlates log lines. */
  traceId?: string;
}

type GenerateParams = Parameters<typeof generateText>[0];

/** The settings streamText and generateText both receive. */
export interface LoopSettings {
  model: GenerateParams['model'];
  instructions: string;
  messages: ModelMessage[];
  tools: ToolSet;
  stopWhen: GenerateParams['stopWhen'];
  timeout: GenerateParams['timeout'];
  prepareStep: GenerateParams['prepareStep'];
  repairToolCall: ToolCallRepairFunction<ToolSet>;
  providerOptions?: GenerateParams['providerOptions'];
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

export interface PreparedLoop {
  settings: LoopSettings;
  maxSteps: number;
  /** Filled while the loop runs, whenever the DSML interceptor recovers a leaked call. */
  dsmlRecoveries: DsmlRecoveryEvent[];
}

export function prepareLoop(input: LoopInput): PreparedLoop {
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
  const dsmlRecoveries: DsmlRecoveryEvent[] = [];
  const providerOptions = providerOptionsFor(input.model);
  const settings: LoopSettings = {
    model: guardedModel(input.model, (event) => {
      dsmlRecoveries.push(event);
      logger.warn('[agent-loop] DSML tool call recovered', {
        traceId: input.traceId,
        tools: event.toolCalls.map((call) => call.name),
      });
    }),
    instructions: input.instructions,
    messages: applyTimeContext(input.messages, input.timeContext),
    tools: input.tools ?? {},
    repairToolCall: repairToolCall(input.traceId),
    stopWhen: input.stopWhen?.length ? [isStepCount(maxSteps), ...input.stopWhen] : isStepCount(maxSteps),
    timeout: LOOP_TIMEOUT,
    // The last step answers in text, so a turn never ends on a tool call.
    prepareStep: ({ stepNumber, messages }: { stepNumber: number; messages: ModelMessage[] }) => {
      const rewritten = input.prepareStepMessages?.({ stepNumber, messages });
      if (stepNumber === maxSteps - 1)
        return { toolChoice: 'none' as const, ...(rewritten ? { messages: rewritten } : {}) };
      return rewritten ? { messages: rewritten } : {};
    },
    ...(providerOptions ? { providerOptions: providerOptions as GenerateParams['providerOptions'] } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  };
  return { settings, maxSteps, dsmlRecoveries };
}

/**
 * A malformed argument string would otherwise drop the whole call, and models do not reliably
 * retry. The repair is local and deterministic; a wrong tool name is left to fail.
 */
function repairToolCall(traceId?: string): ToolCallRepairFunction<ToolSet> {
  return async ({ toolCall, error }) => {
    if (NoSuchToolError.isInstance(error)) return null;
    const repaired = repairJsonArguments(toolCall.input);
    if (repaired === null || repaired === toolCall.input) {
      logger.warn('[agent-loop] tool call arguments could not be repaired', { traceId, tool: toolCall.toolName });
      return null;
    }
    logger.warn('[agent-loop] repaired malformed tool call arguments', { traceId, tool: toolCall.toolName });
    return { ...toolCall, input: repaired };
  };
}

export type LoopStream = ReturnType<typeof streamText<ToolSet>>;

/** Start a streaming turn. Read parts through withFinalAnswer, not `result.stream` directly. */
export function streamLoop(input: LoopInput): PreparedLoop & { result: LoopStream } {
  const prepared = prepareLoop(input);
  return { ...prepared, result: streamText(prepared.settings) };
}

/**
 * The stream of a turn that never ends without an answer: every part passes through, and for
 * DeepSeek a turn that ran tools but wrote nothing gets the final-answer parts spliced in
 * before `finish`. A stopped turn gets no extra calls.
 */
export async function* withFinalAnswer(
  result: LoopStream,
  input: LoopInput,
  createStream?: FinalAnswerStreamFactory,
): AsyncGenerator<any> {
  if (!input.model.deepseek) {
    yield* result.stream as AsyncIterable<any>;
    return;
  }
  let sawText = false;
  let toolRan = false;
  let aborted = false;
  let finish: unknown = null;
  for await (const part of result.stream as AsyncIterable<any>) {
    if (part.type === 'text-delta' && part.text) sawText = true;
    else if (part.type === 'tool-result') toolRan = true;
    else if (part.type === 'abort') aborted = true;
    if (part.type === 'finish') {
      finish = part;
      continue;
    }
    yield part;
  }
  if (!sawText && toolRan && !aborted) {
    const gatheredMessages = (await Promise.resolve(result.responseMessages).catch(() => null)) ?? [];
    yield* finalAnswerParts(
      {
        model: input.model,
        instructions: input.instructions,
        baseMessages: input.messages,
        gatheredMessages,
        ...(input.timeContext !== undefined ? { timeContext: input.timeContext } : {}),
      },
      createStream,
    );
  }
  if (finish) yield finish;
}

type GenerateResult = Awaited<ReturnType<typeof generateText>>;

export interface LoopRunResult {
  text: string;
  finishReason: GenerateResult['finishReason'];
  steps: GenerateResult['steps'];
  responseMessages: ModelMessage[];
  dsmlRecoveries: DsmlRecoveryEvent[];
  /** The loop ran tools but wrote nothing, and the final-answer pass had to answer. */
  finalAnswerRecovered: boolean;
}

/**
 * Run a turn to completion without streaming. Same model, interceptor, repair, bounds and
 * final-answer guarantee as the streaming path.
 */
export async function runLoop(
  input: LoopInput,
  options: {
    onStepEnd?: (info: { stepNumber: number; toolNames: string[] }) => void;
    finalAnswerStream?: FinalAnswerStreamFactory;
  } = {},
): Promise<LoopRunResult> {
  const prepared = prepareLoop(input);
  // chunkMs and firstChunkMs bound a stream; generateText warns about them on every step.
  const { totalMs, stepMs } = LOOP_TIMEOUT;
  let stepNumber = 0;
  const result = await generateText({
    ...prepared.settings,
    timeout: { totalMs, stepMs },
    ...(options.onStepEnd
      ? {
          onStepEnd: (step: { toolCalls?: Array<{ toolName: string }> }) => {
            stepNumber += 1;
            try {
              options.onStepEnd!({ stepNumber, toolNames: (step.toolCalls ?? []).map((call) => call.toolName) });
            } catch (error) {
              // Progress is cosmetic; it must never break the turn.
              logger.warn('[agent-loop] onStepEnd threw', { error: String(error) });
            }
          },
        }
      : {}),
  });

  let text = result.text ?? '';
  let finalAnswerRecovered = false;
  const toolRan = result.steps.some((step) => (step.toolResults?.length ?? 0) > 0);
  // generateText throws on abort, so an empty answer here means the loop ended on its own.
  if (!text.trim() && toolRan && input.model.deepseek) {
    for await (const part of finalAnswerParts(
      {
        model: input.model,
        instructions: input.instructions,
        baseMessages: input.messages,
        gatheredMessages: result.responseMessages,
        ...(input.timeContext !== undefined ? { timeContext: input.timeContext } : {}),
      },
      options.finalAnswerStream,
    )) {
      text += part.text;
    }
    finalAnswerRecovered = text.trim().length > 0;
    logger.warn('[agent-loop] headless turn ended without text after tool use; the final-answer pass ran', {
      traceId: input.traceId,
      recovered: finalAnswerRecovered,
    });
  }

  return {
    text,
    finishReason: result.finishReason,
    steps: result.steps,
    responseMessages: result.responseMessages,
    dsmlRecoveries: prepared.dsmlRecoveries,
    finalAnswerRecovered,
  };
}
