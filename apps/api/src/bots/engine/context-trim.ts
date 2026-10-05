/**
 * In-turn context trimming (spec §4.5, design review R6) — pure.
 *
 * Inside one `streamText` loop every earlier tool result is resent on every
 * step. A browsing turn returns a ~3k-token page snapshot per action, so a
 * dozen actions would push a single turn past the provider's window and cost
 * millions of input tokens. Once the turn's browser/computer output passes
 * ~12k estimated tokens, every such result except the newest is replaced by a
 * short stub (url / title / action). Stubbing happens in batches and is never
 * undone, so the message prefix only changes at batch points and the
 * provider's prefix cache keeps working between them. Tool-call/result pairs
 * stay intact (only the result's payload shrinks).
 *
 * The same compaction keeps snapshots out of `messages.pipeline`.
 */

import type { ModelMessage } from 'ai';
import { estimateTokens } from '@greenhouse/agent-core';
import type { PipelineStep } from '@greenhouse/types/session';

/** Tools whose results are bulky page/terminal observations. */
export const OBSERVATION_TOOLS: ReadonlySet<string> = new Set(['browser', 'computer']);
export const IN_TURN_TOOL_TOKEN_BUDGET = 12_000;
const STUB_MAX_CHARS = 300;

function pickString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string'
    ? found
    : typeof found === 'number' || typeof found === 'boolean'
      ? String(found)
      : undefined;
}

/** A ≤300-char stand-in for an observation that a later one superseded. */
export function observationStub(toolName: string, value: unknown): string {
  const parts = [
    `[${toolName} result replaced by a later one]`,
    pickString(value, 'action') && `action=${pickString(value, 'action')}`,
    pickString(value, 'url') && `url=${pickString(value, 'url')}`,
    pickString(value, 'title') && `title=${pickString(value, 'title')}`,
    pickString(value, 'path') && `path=${pickString(value, 'path')}`,
    // A shared file stays identifiable after its result is stubbed.
    pickString(value, 'file_id') && `file_id=${pickString(value, 'file_id')}`,
    pickString(value, 'name') && `name=${pickString(value, 'name')}`,
    pickString(value, 'exit_code') && `exit_code=${pickString(value, 'exit_code')}`,
    pickString(value, 'error') && `error=${pickString(value, 'error')}`,
  ].filter(Boolean);
  return parts.join(' ').slice(0, STUB_MAX_CHARS);
}

interface ToolResultPartLike {
  type: string;
  toolCallId?: string;
  toolName?: string;
  output?: { type?: string; value?: unknown };
}

function resultValue(part: ToolResultPartLike): unknown {
  return part.output?.value;
}

function resultTokens(part: ToolResultPartLike): number {
  const value = resultValue(part);
  return estimateTokens(typeof value === 'string' ? value : JSON.stringify(value ?? ''));
}

/**
 * Build the `prepareStepMessages` hook for one turn. Returns undefined (no
 * rewrite) until the first batch point.
 */
export function createObservationTrimmer(budgetTokens = IN_TURN_TOOL_TOKEN_BUDGET) {
  const stubbed = new Set<string>();
  return ({ messages }: { stepNumber: number; messages: ModelMessage[] }): ModelMessage[] | undefined => {
    const live: ToolResultPartLike[] = [];
    for (const message of messages) {
      if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
      for (const part of message.content as ToolResultPartLike[]) {
        if (part.type !== 'tool-result' || !part.toolCallId || !OBSERVATION_TOOLS.has(part.toolName ?? '')) continue;
        if (!stubbed.has(part.toolCallId)) live.push(part);
      }
    }
    const liveTokens = live.reduce((sum, part) => sum + resultTokens(part), 0);
    if (liveTokens > budgetTokens && live.length > 1) {
      for (const part of live.slice(0, -1)) stubbed.add(part.toolCallId!);
    }
    if (stubbed.size === 0) return undefined;
    return messages.map((message) => {
      if (message.role !== 'tool' || !Array.isArray(message.content)) return message;
      let changed = false;
      const content = (message.content as ToolResultPartLike[]).map((part) => {
        if (part.type !== 'tool-result' || !part.toolCallId || !stubbed.has(part.toolCallId)) return part;
        changed = true;
        return {
          ...part,
          output: { type: 'text', value: observationStub(part.toolName ?? 'tool', resultValue(part)) },
        };
      });
      return changed ? ({ ...message, content } as ModelMessage) : message;
    });
  };
}

const PIPELINE_KEEP_KEYS = [
  'action',
  'url',
  'title',
  'ok',
  'status',
  'error',
  'exit_code',
  'path',
  'timed_out',
  'filled',
];

/**
 * Keep observation tools' pipeline entries small: facts about the action, not
 * the page. A file artifact — the computer's `share_file`, the browser's
 * `screenshot` — is kept whole: it is a handful of small fields, and the
 * transcript's file/image card is built from exactly that shape
 * (type/file_id/name/download_url), so filtering it would make the file vanish
 * once the live turn is replaced by the persisted row.
 */
export function compactObservationPipeline(steps: PipelineStep[]): PipelineStep[] {
  return steps.map((step) => {
    if (!OBSERVATION_TOOLS.has(step.tool) || !step.output || typeof step.output !== 'object') return step;
    const output = step.output as Record<string, unknown>;
    if (output.type === 'file' && typeof output.file_id === 'string') return step;
    const kept: Record<string, unknown> = {};
    for (const key of PIPELINE_KEEP_KEYS) if (key in output) kept[key] = output[key];
    for (const key of ['stdout', 'stderr', 'text', 'content']) {
      const value = output[key];
      if (typeof value === 'string' && value) kept[key] = value.length > 500 ? `${value.slice(0, 500)}…` : value;
    }
    return { ...step, output: kept };
  });
}
