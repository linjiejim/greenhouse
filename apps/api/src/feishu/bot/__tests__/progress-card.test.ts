/**
 * The "正在处理…" card's update discipline: throttled far under Feishu's
 * 5-per-second-per-message limit, never out of order, and the answer always
 * lands last — even with an update still in flight.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgressCard, progressText, PROGRESS_START_TEXT } from '../progress-card.js';

function fakePatch(delayMs = 0, ok = true) {
  const sent: string[] = [];
  const patch = vi.fn(async (content: string) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    sent.push(content);
    return { ok };
  });
  return { patch, sent };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createProgressCard', () => {
  it('sends the first step at once and coalesces a burst into the latest one', async () => {
    const { patch, sent } = fakePatch();
    const card = createProgressCard(patch, { now: () => Date.now(), minIntervalMs: 1500 });

    card.onStep({ stepNumber: 1, toolNames: ['knowledge_query'] });
    card.onStep({ stepNumber: 2, toolNames: ['knowledge_query'] });
    card.onStep({ stepNumber: 3, toolNames: ['external_search'] });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('已完成 1 步');

    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(1); // the patch itself resolves on the next tick
    // Steps 2 and 3 arrived inside one interval: only the latest is shown.
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('已完成 3 步');
  });

  it('the answer goes out last, after an update still in flight, and cancels a queued one', async () => {
    const { patch, sent } = fakePatch(200);
    const card = createProgressCard(patch, { now: () => Date.now(), minIntervalMs: 1500 });

    card.onStep({ stepNumber: 1, toolNames: [] }); // in flight for 200ms
    card.onStep({ stepNumber: 2, toolNames: [] }); // queued behind the throttle
    const done = card.finish('**答案**');
    await vi.advanceTimersByTimeAsync(1000);

    expect(await done).toBe(true);
    expect(sent).toEqual([progressText(1, []), '**答案**']);
    // Nothing fires after the answer.
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent.at(-1)).toBe('**答案**');
  });

  it('reports a refused final update so the caller can fall back to a new reply', async () => {
    const { patch } = fakePatch(0, false);
    const card = createProgressCard(patch);
    const done = card.finish('answer');
    await vi.advanceTimersByTimeAsync(0);
    expect(await done).toBe(false);
  });
});

describe('progressText', () => {
  it('shows the step count and the tools by their display names, once each', () => {
    const text = progressText(2, ['knowledge_query', 'knowledge_query', 'unknown_tool']);
    expect(text.startsWith(PROGRESS_START_TEXT)).toBe(true);
    expect(text).toContain('已完成 2 步');
    expect(text.match(/unknown_tool/g)).toHaveLength(1);
  });
});
