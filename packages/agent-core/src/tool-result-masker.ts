/**
 * In-turn tool-result masking — keep one long agent turn's context bounded.
 *
 * Inside one loop every earlier tool result is resent on every step, so a
 * research turn that reads six documents pays for all six again on each of
 * the following steps, until it hits the provider's window. Once the turn's
 * live (unmasked) maskable results pass `budgetTokens`, the OLDEST are
 * replaced by a short stub until what remains fits `retainTokens` — the
 * newest result is never masked. This is "observation masking": JetBrains
 * measured it at about half the cost of a raw agent while solving as many
 * SWE-bench tasks as LLM summarisation (arXiv 2508.21433), with no model call.
 *
 * Masking happens in batches and is never undone, so the message prefix only
 * changes at batch points and the provider's prefix cache keeps working in
 * between. Tool-call/result pairs stay intact — only a result's payload
 * shrinks — and the stub says how to get the content back (call again).
 *
 * With `pinRefetched`, a re-fetch is a signal, not noise: when the model calls
 * a tool again with the exact input of a result that was masked, it needs that
 * content, so the new result is PINNED (never masked). Without this a turn
 * that must hold two large results at once ping-pongs — fetch A, mask B; fetch
 * B, mask A — until the step cap (observed with deepseek-v4-flash on
 * 2026-10-09). A signature pins once, so a stateful tool called repeatedly
 * with the same input cannot pin its way past the budget. Off for Bots: there
 * the same `snapshot` input returns a NEW page each time — a later observation
 * supersedes an earlier one rather than re-fetching it.
 *
 * Pure: hosts pick the budget, which tools may be masked and the stub text.
 * The Bots engine masks only superseded browser/computer observations; chat
 * masks any tool result, but only past a much larger budget.
 */

import type { ModelMessage } from 'ai';
import { estimateTokens } from './context-budget.js';

export interface ToolResultMaskerOptions {
  /** Live maskable results above this many estimated tokens trigger a batch. */
  budgetTokens: number;
  /**
   * After a batch, the newest results totalling at most this many tokens stay
   * intact (the newest one always does). 0 = keep only the newest.
   */
  retainTokens?: number;
  /** Which tools' results may be masked (default: every tool). */
  isMaskable?: (toolName: string) => boolean;
  /** The ≤ few-hundred-character stand-in for a masked result. */
  stub: (toolName: string, value: unknown, input: unknown) => string;
  /** Called once per batch — hosts log it (it is the evidence for tuning the budget). */
  onBatch?: (info: ToolResultMaskBatch) => void;
  /** Pin a result whose call repeats a masked call exactly (see above). Default false. */
  pinRefetched?: boolean;
  /** Called when the model re-fetched a masked result (now pinned) — the budget was too tight for it. */
  onRefetch?: (info: { stepNumber: number; toolName: string }) => void;
}

export interface ToolResultMaskBatch {
  stepNumber: number;
  /** Results masked by this batch. */
  masked: number;
  liveTokensBefore: number;
  liveTokensAfter: number;
}

interface ToolPartLike {
  type: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: { type?: string; value?: unknown };
}

function resultValue(part: ToolPartLike): unknown {
  return part.output?.value;
}

export function toolResultTokens(value: unknown): number {
  return estimateTokens(typeof value === 'string' ? value : JSON.stringify(value ?? ''));
}

/** Key-order-independent JSON, so `{a,b}` and `{b,a}` name the same call. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function callSignature(toolName: string, input: unknown): string {
  return `${toolName}\u0000${canonical(input)}`;
}

/**
 * Build the per-step `prepareStepMessages` hook for ONE turn (it is stateful:
 * it remembers what it masked). Returns undefined until the first batch.
 */
export function createToolResultMasker(opts: ToolResultMaskerOptions) {
  const masked = new Set<string>();
  /** Signatures (tool + exact input) of masked results — a later identical call is a re-fetch. */
  const maskedSignatures = new Set<string>();
  const pinned = new Set<string>();
  const retain = Math.max(0, opts.retainTokens ?? 0);
  const maskable = opts.isMaskable ?? (() => true);

  return ({ stepNumber, messages }: { stepNumber: number; messages: ModelMessage[] }): ModelMessage[] | undefined => {
    const inputs = new Map<string, unknown>();
    const live: Array<{ part: ToolPartLike; tokens: number }> = [];
    let pinnedTokens = 0;
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content as ToolPartLike[]) {
        if (!part?.toolCallId) continue;
        if (message.role === 'assistant' && part.type === 'tool-call') {
          inputs.set(part.toolCallId, part.input);
          continue;
        }
        if (
          message.role !== 'tool' ||
          part.type !== 'tool-result' ||
          masked.has(part.toolCallId) ||
          !maskable(part.toolName ?? '')
        ) {
          continue;
        }
        const tokens = toolResultTokens(resultValue(part));
        if (opts.pinRefetched && !pinned.has(part.toolCallId)) {
          const signature = callSignature(part.toolName ?? '', inputs.get(part.toolCallId));
          if (maskedSignatures.has(signature)) {
            pinned.add(part.toolCallId);
            maskedSignatures.delete(signature); // one pin per masked call
            opts.onRefetch?.({ stepNumber, toolName: part.toolName ?? 'tool' });
          }
        }
        if (pinned.has(part.toolCallId)) pinnedTokens += tokens;
        else live.push({ part, tokens });
      }
    }

    const liveTokens = live.reduce((sum, entry) => sum + entry.tokens, 0) + pinnedTokens;
    if (liveTokens > opts.budgetTokens && live.length > 1) {
      // Walk newest → oldest over the maskable results: the newest always
      // stays, then keep while the retained total (pinned included) fits;
      // everything older is masked in this batch.
      let kept = pinnedTokens + live[live.length - 1]!.tokens;
      let batch = 0;
      let keeping = true;
      for (let i = live.length - 2; i >= 0; i--) {
        const entry = live[i]!;
        if (keeping && kept + entry.tokens <= retain) {
          kept += entry.tokens;
          continue;
        }
        keeping = false;
        masked.add(entry.part.toolCallId!);
        maskedSignatures.add(callSignature(entry.part.toolName ?? '', inputs.get(entry.part.toolCallId!)));
        batch++;
      }
      if (batch > 0) {
        opts.onBatch?.({ stepNumber, masked: batch, liveTokensBefore: liveTokens, liveTokensAfter: kept });
      }
    }

    if (masked.size === 0) return undefined;
    return messages.map((message) => {
      if (message.role !== 'tool' || !Array.isArray(message.content)) return message;
      let changed = false;
      const content = (message.content as ToolPartLike[]).map((part) => {
        if (part.type !== 'tool-result' || !part.toolCallId || !masked.has(part.toolCallId)) return part;
        changed = true;
        return {
          ...part,
          output: {
            type: 'text',
            value: opts.stub(part.toolName ?? 'tool', resultValue(part), inputs.get(part.toolCallId)),
          },
        };
      });
      return changed ? ({ ...message, content } as ModelMessage) : message;
    });
  };
}

// ─── The chat preset ─────────────────────────────────────

/** Input keys that identify what a call fetched — enough to fetch it again. */
const IDENTIFYING_INPUT_KEYS = [
  'action',
  'scope',
  'doc_id',
  'id',
  'ids',
  'section',
  'query',
  'url',
  'file_id',
  'server',
  'tool',
  'path',
] as const;
const STUB_MAX_CHARS = 300;

/** "What this call asked for", compactly — the part of the input worth keeping. */
function identifyingInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const picked: Record<string, unknown> = {};
  for (const key of IDENTIFYING_INPUT_KEYS) {
    const value = (input as Record<string, unknown>)[key];
    if (value !== undefined && value !== null && value !== '') picked[key] = value;
  }
  return Object.keys(picked).length > 0 ? JSON.stringify(picked) : '';
}

/** The stub chat writes in place of a masked result. */
export function chatMaskStub(toolName: string, _value: unknown, input: unknown): string {
  const call = identifyingInput(input);
  return (
    `[${toolName} result omitted to keep this turn within its context budget` +
    (call ? `; it was called with ${call}` : '') +
    ' — call the tool again if you still need it]'
  ).slice(0, STUB_MAX_CHARS);
}

/** The most a chat turn's tool results may occupy before the oldest are masked. */
export const CHAT_IN_TURN_TOOL_TOKEN_BUDGET = 32_000;

/**
 * The chat budget for a model: 32k tokens of live tool output, or a quarter
 * of a smaller model's window (history already gets half of it — see
 * resolveHistoryBudget — and the rest is system prompt, tools and output),
 * plus `unusedHistoryTokens` when the caller lends the history budget its
 * history left unused.
 *
 * Lend it only where cache hits are nearly free (hasCheapPromptCache): a fold
 * turns the cached suffix after it into misses. At a hit priced 1/50 of a miss
 * (DeepSeek, 2026-10) an 8-fetch turn masked at 32k came out ~19% dearer than
 * resending everything, so there masking is kept for what only it does —
 * holding a long conversation inside the window. Above a hit ≈1/10 of a miss
 * the same turn is cheaper masked and the base budget stands (spec 20261009
 * D6). Either way the payload never grows past a full history plus the base.
 */
export function resolveInTurnToolBudget(contextWindow: number | undefined, unusedHistoryTokens = 0): number {
  const base = contextWindow
    ? Math.min(CHAT_IN_TURN_TOOL_TOKEN_BUDGET, Math.floor(contextWindow * 0.25))
    : CHAT_IN_TURN_TOOL_TOKEN_BUDGET;
  return base + Math.max(0, Math.floor(unusedHistoryTokens));
}
