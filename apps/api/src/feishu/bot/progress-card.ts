/**
 * The "正在处理…" card — spec D10 of the Feishu bot, built 2026-10-09.
 *
 * D10 decided against token streaming (repeated edits of one message hit
 * Feishu's rate limits) and for this instead: reply a placeholder card at once,
 * update it as steps finish, replace it with the answer at the end. Without it
 * a member stared at nothing for the whole agent turn and resent the question.
 *
 * Updates are serialised (a PATCH never overtakes the one before it) and
 * throttled to one per PROGRESS_MIN_INTERVAL_MS — Feishu allows 5 per second
 * per message; a step takes seconds, so nothing is lost but noise. The final
 * answer always goes out, after any update still in flight.
 */

import { getToolMeta } from '../../tools/registry.js';

export type CardPatch = (content: string) => Promise<{ ok: boolean; error?: string }>;

export const PROGRESS_MIN_INTERVAL_MS = 1500;

export const PROGRESS_START_TEXT = '⏳ **正在处理…**';

/** The card body while the agent works: how far it got and what it last used. */
export function progressText(stepNumber: number, toolNames: readonly string[]): string {
  const tools = [...new Set(toolNames)].map((id) => getToolMeta(id)?.name ?? id);
  return `${PROGRESS_START_TEXT}\n\n已完成 ${stepNumber} 步${tools.length > 0 ? ` · ${tools.join('、')}` : ''}`;
}

export interface ProgressCard {
  /** Feed to the runner's `onStep`. */
  onStep(info: { stepNumber: number; toolNames: string[] }): void;
  /** Replace the card with the answer; false when Feishu refused (caller falls back to a new reply). */
  finish(content: string): Promise<boolean>;
}

export function createProgressCard(
  patch: CardPatch,
  opts: { now?: () => number; minIntervalMs?: number } = {},
): ProgressCard {
  const now = opts.now ?? (() => Date.now());
  const interval = opts.minIntervalMs ?? PROGRESS_MIN_INTERVAL_MS;
  let chain: Promise<unknown> = Promise.resolve();
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;

  const send = (content: string) => {
    lastSentAt = now();
    // Serialise: each PATCH waits for the previous one, so the card never
    // goes backwards. Progress failures are cosmetic — swallowed here.
    chain = chain.then(() => patch(content)).catch(() => undefined);
  };

  const flushPending = () => {
    timer = null;
    if (finished || pending === null) return;
    const content = pending;
    pending = null;
    send(content);
  };

  return {
    onStep(info) {
      if (finished) return;
      pending = progressText(info.stepNumber, info.toolNames);
      const wait = lastSentAt + interval - now();
      if (wait <= 0) flushPending();
      else if (!timer) timer = setTimeout(flushPending, wait);
    },

    async finish(content) {
      finished = true;
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
      await chain;
      const result = await patch(content).catch(() => ({ ok: false }));
      return result.ok;
    },
  };
}
