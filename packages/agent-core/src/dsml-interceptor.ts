/**
 * DSML Interceptor — AI SDK middleware that recovers DeepSeek DSML
 * tool calls leaked as text-delta stream events.
 *
 * Background: DeepSeek V4 models use DSML (DeepSeek Markup Language) as
 * their native tool call format. The API layer normally parses DSML into
 * OpenAI-compatible tool_calls, but occasionally fails — leaking raw DSML
 * tokens into delta.content. This causes:
 *   1. Raw DSML XML shown to the user
 *   2. finishReason = 'stop' instead of 'tool_calls'
 *   3. Agent loop terminates, tools don't execute, response is cut off
 *
 * This middleware intercepts the model stream, detects DSML blocks in
 * text-delta events, parses them into proper tool-call events, and fixes
 * finishReason so the AI SDK agent loop continues normally.
 *
 * References:
 * - DeepSeek V4 encoding docs: huggingface.co/deepseek-ai/DeepSeek-V4-Flash
 * - Cherry Studio fix: github.com/CherryHQ/cherry-studio/pull/14747
 * - vLLM DSML parser: docs.vllm.ai/en/latest/api/vllm/tool_parsers/deepseekv4_tool_parser/
 *
 * Removal: This file is one half of a DeepSeek-only workaround bundle. When
 * DeepSeek fixes their API-side parser, remove the whole bundle:
 *   1. Delete this file + the 2-line model wrapping in chat-engine.ts.
 *   2. Delete the "Final-Answer Guarantee" section in chat-engine.ts (the empty
 *      answer it recovers is also a DSML-leak symptom — see withFinalAnswerGuarantee).
 *   3. In each host, swap `withFinalAnswerGuarantee(streamResult, …)` back to
 *      `streamResult.fullStream` (one line in each remaining host).
 */

import type { LanguageModelMiddleware } from 'ai';
import { logger } from '@greenhouse/utils/logger';

// ─── Types ───────────────────────────────────────────────

/**
 * Minimal stream part type for the DSML interceptor.
 * We use `any` internally because LanguageModelV3StreamPart is a complex
 * discriminated union not re-exported by the `ai` package. Runtime type
 * checks (part.type === '...') provide the actual safety.
 */
type StreamPart = any;

export interface DsmlRecoveryEvent {
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  timestamp: string;
}

interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
}

// ─── Legacy Tool-Name Aliases ────────────────────────────

// DeepSeek sometimes emits OLD split tool names (get_team_knowledge /
// search_team_knowledge) that were merged into a single `knowledge_query` tool
// with an `action` arg. Without this remap, a recovered DSML call targets a
// non-existent tool and silently no-ops (the user sees garbled DSML or a dead
// turn). Map the legacy names back to the unified tool + action.
const LEGACY_TOOL_ALIASES: Record<string, { name: string; action: string }> = {
  get_team_knowledge: { name: 'knowledge_query', action: 'get' },
  search_team_knowledge: { name: 'knowledge_query', action: 'search' },
  get_personal_knowledge: { name: 'knowledge_query', action: 'get' },
  search_personal_knowledge: { name: 'knowledge_query', action: 'search' },
};

export function normalizeToolCall(call: ParsedToolCall): ParsedToolCall {
  const alias = LEGACY_TOOL_ALIASES[call.name];
  if (!alias) return call;
  // Existing args win over the injected default action, but legacy names never
  // carry an `action`, so this just supplies it.
  return { name: alias.name, args: { action: alias.action, ...call.args } };
}

// ─── DSML Detection Patterns ─────────────────────────────

// ｜ = U+FF5C (full-width vertical bar), | = U+007C (ASCII pipe)
// Official format: <｜DSML｜tool_calls>  (single full-width bars)
// Observed variant: <｜｜DSML｜｜tool_calls>  (double full-width bars)
// Rendered variant: < | DSML | | tool_calls>  (ASCII with spaces)
const BAR = '[｜|]'; // either full-width or ASCII pipe
const DSML_START_RE = new RegExp(`<${BAR}{1,2}\\s*DSML\\s*${BAR}{1,2}\\s*tool_calls\\s*>`);
const DSML_END_RE = new RegExp(`</${BAR}{1,2}\\s*DSML\\s*${BAR}{1,2}\\s*tool_calls\\s*>`);

// Potential start: a '<' that could begin a DSML tag
const POTENTIAL_START_CHAR = '<';

// Max bytes to buffer before giving up (prevents infinite buffering on malformed output)
const MAX_BUFFER_SIZE = 64 * 1024;

// ─── DSML Block Parser ──────────────────────────────────

/**
 * Parse a complete DSML block into structured tool calls.
 *
 * Example input:
 * ```
 * <｜DSML｜invoke name="knowledge_query">
 * <｜DSML｜parameter name="query" string="true">basil growing guide</｜DSML｜parameter>
 * <｜DSML｜parameter name="limit" string="false">5</｜DSML｜parameter>
 * </｜DSML｜invoke>
 * ```
 */
export function parseDsmlBlock(block: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];

  // Match invoke blocks
  const invokeRe = new RegExp(
    `<${BAR}{1,2}\\s*DSML\\s*${BAR}{1,2}\\s*invoke\\s+name="([^"]+)"\\s*>` +
      `([\\s\\S]*?)` +
      `</${BAR}{1,2}\\s*DSML\\s*${BAR}{1,2}\\s*invoke\\s*>`,
    'g',
  );

  let invokeMatch: RegExpExecArray | null;
  while ((invokeMatch = invokeRe.exec(block)) !== null) {
    const toolName = invokeMatch[1];
    const invokeBody = invokeMatch[2];
    const args: Record<string, unknown> = {};

    // Match parameter blocks within this invoke
    const paramRe = new RegExp(
      `<${BAR}{1,2}\\s*DSML\\s*${BAR}{1,2}\\s*parameter\\s+name="([^"]+)"\\s+string="(true|false)"\\s*>` +
        `([\\s\\S]*?)` +
        `</${BAR}{1,2}\\s*DSML\\s*${BAR}{1,2}\\s*parameter\\s*>`,
      'g',
    );

    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramRe.exec(invokeBody)) !== null) {
      const paramName = paramMatch[1];
      const isString = paramMatch[2] === 'true';
      const rawValue = paramMatch[3].trim();

      if (isString) {
        args[paramName] = rawValue;
      } else {
        // JSON value: number, boolean, array, object
        try {
          args[paramName] = JSON.parse(rawValue);
        } catch {
          args[paramName] = rawValue;
        }
      }
    }

    results.push(normalizeToolCall({ name: toolName, args }));
  }

  return results;
}

// ─── Stream Transform ────────────────────────────────────

/**
 * Generate a random tool call ID matching DeepSeek's format.
 */
function generateCallId(): string {
  const hex = Array.from({ length: 24 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `call_dsml_${hex}`;
}

const enum State {
  NORMAL = 0,
  BUFFERING = 1,
}

/**
 * Create a TransformStream that intercepts DSML tool call blocks in
 * text-delta events and converts them to tool-call events.
 *
 * `toolsDisabled` is true for a step the SDK ran with `toolChoice: 'none'`
 * (e.g. the final "answer now" step the agent loop forces at max_steps). On
 * such a step a recovered tool call can never execute, and rewriting
 * finishReason to 'tool-calls' would strand the turn with no answer — defeating
 * the very safeguard that forces a text answer. So we still strip the leaked
 * DSML out of the text, but we do NOT re-emit it as a tool call and leave
 * finishReason untouched.
 */
function createDsmlTransform(
  onRecovered?: (event: DsmlRecoveryEvent) => void,
  toolsDisabled = false,
): TransformStream<StreamPart, StreamPart> {
  let state: State = State.NORMAL;
  let buffer = '';
  const recoveredCalls: ParsedToolCall[] = [];
  const properCallKeys = new Set<string>(); // name+args of tool calls the API parsed properly
  let textId = 'txt-0'; // reuse the text-start id from the original stream
  let hasTextStart = false;

  return new TransformStream<StreamPart, StreamPart>({
    transform(part, controller) {
      // Track tool calls the API parsed properly so we can de-dupe recovered ones.
      if (part.type === 'tool-call') {
        const input = typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {});
        properCallKeys.add(`${part.toolName}:${input}`);
      }

      // Only intercept text-related events
      if (part.type === 'text-start') {
        hasTextStart = true;
        textId = part.id;
        // Don't emit yet — we'll emit when we know there's actual text
        return;
      }

      if (part.type === 'text-delta') {
        const text = part.delta;

        if (state === State.NORMAL) {
          // Check if this chunk contains the start of a DSML block
          const startMatch = DSML_START_RE.exec(text);
          if (startMatch) {
            // Text before the DSML start → emit as normal text
            const beforeDsml = text.slice(0, startMatch.index);
            if (beforeDsml) {
              emitTextDelta(controller, textId, beforeDsml, hasTextStart);
              hasTextStart = false; // already emitted
            }
            // Start buffering from the DSML start marker
            buffer = text.slice(startMatch.index);
            state = State.BUFFERING;

            // Check if the end marker is also in this chunk
            checkBufferComplete(controller);
            return;
          }

          // Check for potential partial DSML start at the end of chunk
          // (e.g., chunk ends with "<" or "<｜" or "<｜DSML")
          const potentialIdx = text.lastIndexOf(POTENTIAL_START_CHAR);
          if (potentialIdx >= 0 && potentialIdx > text.length - 40) {
            // The tail might be the start of a DSML marker
            const tail = text.slice(potentialIdx);
            // Quick check: does the tail look like it could be DSML?
            if (couldBeDsmlStart(tail)) {
              // Emit text before the potential start
              const safePart = text.slice(0, potentialIdx);
              if (safePart) {
                emitTextDelta(controller, textId, safePart, hasTextStart);
                hasTextStart = false;
              }
              buffer = tail;
              state = State.BUFFERING;
              return;
            }
          }

          // Normal text — pass through
          emitTextDelta(controller, textId, text, hasTextStart);
          hasTextStart = false;
          return;
        }

        if (state === State.BUFFERING) {
          buffer += text;

          // Safety: abandon buffer if too large
          if (buffer.length > MAX_BUFFER_SIZE) {
            logger.warn('[dsml-interceptor] Buffer exceeded max size, flushing as text');
            emitTextDelta(controller, textId, buffer, hasTextStart);
            hasTextStart = false;
            buffer = '';
            state = State.NORMAL;
            return;
          }

          checkBufferComplete(controller);
          return;
        }

        return;
      }

      if (part.type === 'text-end') {
        // If we have buffered content that never matched DSML, flush it
        if (buffer) {
          emitTextDelta(controller, textId, buffer, hasTextStart);
          hasTextStart = false;
          buffer = '';
          state = State.NORMAL;
        }

        // Only emit text-end if we emitted text-start
        // (if we had hasTextStart still true, there was no text at all)
        if (!hasTextStart) {
          controller.enqueue(part);
        }
        return;
      }

      if (part.type === 'finish') {
        // On a tools-disabled step, never recover: the call can't run and the
        // finishReason rewrite would strand the final answer. The DSML markup
        // was already stripped from the text above, so just pass finish through.
        if (toolsDisabled && recoveredCalls.length > 0) {
          logger.info(
            `[dsml-interceptor] DSML leaked on a tools-disabled step — stripped without recovery (${recoveredCalls.map((t) => t.name).join(', ')})`,
          );
        }

        // Emit any recovered DSML tool calls that the API didn't already parse.
        // (Previously suppressed whenever ANY proper tool call existed, which let
        // co-occurring leaked DSML reach the user as garbled text. Knowledge
        // reads are idempotent, so a rare duplicate is harmless.)
        const callsToEmit = toolsDisabled
          ? []
          : recoveredCalls.filter((tc) => !properCallKeys.has(`${tc.name}:${JSON.stringify(tc.args)}`));
        if (callsToEmit.length > 0) {
          // Emit tool call events
          for (const tc of callsToEmit) {
            const callId = generateCallId();
            const argsJson = JSON.stringify(tc.args);

            controller.enqueue({
              type: 'tool-input-start',
              id: callId,
              toolName: tc.name,
            });
            controller.enqueue({
              type: 'tool-input-delta',
              id: callId,
              delta: argsJson,
            });
            controller.enqueue({
              type: 'tool-input-end',
              id: callId,
            });
            controller.enqueue({
              type: 'tool-call',
              toolCallId: callId,
              toolName: tc.name,
              input: argsJson,
            });
          }

          // Fix finishReason from 'stop' to 'tool-calls'
          if (part.finishReason.unified === 'stop') {
            controller.enqueue({
              ...part,
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            });

            // Notify callback
            if (onRecovered) {
              onRecovered({
                toolCalls: callsToEmit.map((tc) => ({ name: tc.name, args: tc.args })),
                timestamp: new Date().toISOString(),
              });
            }
            return;
          }
        }

        controller.enqueue(part);
        return;
      }

      // All other event types — pass through unchanged
      controller.enqueue(part);
    },

    flush(controller) {
      // Handle any remaining buffer on stream close
      if (buffer) {
        emitTextDelta(controller, textId, buffer, hasTextStart);
        hasTextStart = false;
        buffer = '';
      }
    },
  });

  // ── Internal helpers ──

  function checkBufferComplete(controller: TransformStreamDefaultController<StreamPart>) {
    // First, check if the buffer actually contains a full DSML start marker
    if (!DSML_START_RE.test(buffer)) {
      // The full start marker isn't present *yet*. The model streams it
      // token-by-token (`<` · `｜｜DSML｜｜` · `tool_calls>`), so a buffer like
      // `<｜｜DSML｜｜` is a partial start still arriving — not a false alarm.
      // Keep buffering while it could still grow into a start marker; only
      // flush as text once it definitively can't (e.g. a literal `<` in prose).
      if (couldBeDsmlStart(buffer)) {
        return;
      }
      emitTextDelta(controller, textId, buffer, hasTextStart);
      hasTextStart = false;
      buffer = '';
      state = State.NORMAL;
      return;
    }

    // Check if we have the complete DSML block (end marker present)
    const endMatch = DSML_END_RE.exec(buffer);
    if (!endMatch) {
      // Still waiting for the end marker
      return;
    }

    // We have a complete DSML block — parse it
    const dsmlEnd = endMatch.index + endMatch[0].length;
    const dsmlBlock = buffer.slice(0, dsmlEnd);
    const afterDsml = buffer.slice(dsmlEnd).trim();

    const parsed = parseDsmlBlock(dsmlBlock);

    if (parsed.length > 0) {
      recoveredCalls.push(...parsed);
      logger.info(
        `[dsml-interceptor] Parsed ${parsed.length} tool call(s) from DSML block: ${parsed.map((t) => t.name).join(', ')}`,
      );
    } else {
      // Failed to parse — flush as text (graceful degradation)
      logger.warn('[dsml-interceptor] DSML block detected but parsing failed, flushing as text');
      emitTextDelta(controller, textId, dsmlBlock, hasTextStart);
      hasTextStart = false;
    }

    // Any text after the DSML block
    if (afterDsml) {
      emitTextDelta(controller, textId, afterDsml, hasTextStart);
      hasTextStart = false;
    }

    buffer = '';
    state = State.NORMAL;
  }
}

/**
 * Emit a text-delta event, prepending text-start if needed.
 */
function emitTextDelta(
  controller: TransformStreamDefaultController<StreamPart>,
  textId: string,
  text: string,
  needsTextStart: boolean,
) {
  if (needsTextStart) {
    controller.enqueue({ type: 'text-start', id: textId });
  }
  controller.enqueue({ type: 'text-delta', id: textId, delta: text });
}

/**
 * Check if a string tail could be the beginning of a DSML start marker.
 * This handles chunk-boundary cases like "<", "<｜", "<｜DSML", etc.
 */
function couldBeDsmlStart(tail: string): boolean {
  // The full start marker looks like: <｜DSML｜tool_calls> or <｜｜DSML｜｜tool_calls>
  // We check if the tail is a prefix of any valid DSML start marker pattern
  const candidates = [
    '<｜DSML｜tool_calls>',
    '<｜｜DSML｜｜tool_calls>',
    '<|DSML|tool_calls>',
    '<||DSML||tool_calls>',
    '< | DSML | tool_calls>',
    '< | DSML | | tool_calls>',
    '< || DSML || tool_calls>',
  ];
  const normalized = tail.trim();
  return candidates.some((c) => c.startsWith(normalized) && normalized.length < c.length);
}

// ─── Middleware Factory ──────────────────────────────────

/**
 * Create an AI SDK LanguageModelMiddleware that intercepts DSML tool call
 * leaks in DeepSeek model streams.
 *
 * Usage:
 * ```ts
 * import { wrapLanguageModel } from 'ai';
 * import { createDsmlInterceptor } from './dsml-interceptor.js';
 *
 * const model = wrapLanguageModel({
 *   model: rawModel,
 *   middleware: createDsmlInterceptor((event) => {
 *     logger.warn('DSML recovered', event);
 *   }),
 * });
 * ```
 */
export function createDsmlInterceptor(onRecovered?: (event: DsmlRecoveryEvent) => void): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    wrapStream: async ({ doStream, params }) => {
      const result = await doStream();
      // The SDK runs the final answer step with toolChoice 'none' to force a
      // text answer. Tell the transform so a DSML leak there isn't recovered
      // into an un-runnable tool call that strands the turn (the v1 streaming
      // "0 content" bug).
      const toolsDisabled = (params as { toolChoice?: { type?: string } } | undefined)?.toolChoice?.type === 'none';
      return {
        ...result,
        stream: result.stream.pipeThrough(
          createDsmlTransform(onRecovered, toolsDisabled) as ReadableWritablePair<StreamPart, StreamPart>,
        ),
      };
    },
  };
}
