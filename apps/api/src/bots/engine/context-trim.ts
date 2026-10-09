/**
 * In-turn context trimming (spec §4.5, design review R6) — pure.
 *
 * Inside one `streamText` loop every earlier tool result is resent on every
 * step. A browsing turn returns a ~3k-token page snapshot per action, so a
 * dozen actions would push a single turn past the provider's window and cost
 * millions of input tokens. Once the turn's browser/computer output passes
 * ~12k estimated tokens, every such result except the newest is replaced by a
 * short stub (url / title / action) — a later page supersedes an earlier one.
 *
 * The batching/masking mechanics are agent-core's `createToolResultMasker`,
 * the same one chat uses with a larger budget; this file owns only the Bots
 * policy (which tools, keep just the newest, the observation stub).
 *
 * The same compaction keeps snapshots out of `messages.pipeline`.
 */

import type { ModelMessage } from 'ai';
import { createToolResultMasker } from '@greenhouse/agent-core';
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

/**
 * Build the `prepareStepMessages` hook for one turn. Returns undefined (no
 * rewrite) until the first batch point.
 */
export function createObservationTrimmer(
  budgetTokens = IN_TURN_TOOL_TOKEN_BUDGET,
): (args: { stepNumber: number; messages: ModelMessage[] }) => ModelMessage[] | undefined {
  return createToolResultMasker({
    budgetTokens,
    retainTokens: 0,
    isMaskable: (toolName) => OBSERVATION_TOOLS.has(toolName),
    stub: (toolName, value) => observationStub(toolName, value),
  });
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
