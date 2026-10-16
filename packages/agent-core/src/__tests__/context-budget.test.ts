/**
 * Contract tests for the pre-send history window.
 *
 * The chat route sends a session's whole transcript each turn; this window is
 * the only thing standing between a long-lived session and a provider
 * context-length error. Pin the drop-oldest/keep-newest semantics.
 */

import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  windowMessagesByBudget,
  resolveHistoryBudget,
  HISTORY_TOKEN_BUDGET,
  DEFAULT_COMPACTION_THRESHOLD,
} from '../context-budget.js';

describe('estimateTokens', () => {
  it('counts non-CJK text at ~4 chars per token', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('counts CJK text at ~1 token per char', () => {
    expect(estimateTokens('水培生菜营养液配比')).toBe(9);
  });

  it('handles mixed text and empty input', () => {
    expect(estimateTokens('')).toBe(0);
    // 4 CJK chars + 8 latin chars → 4 + 2
    expect(estimateTokens('营养液盐abcdefgh')).toBe(6);
  });
});

describe('windowMessagesByBudget', () => {
  const msg = (content: string) => ({ role: 'user', content });

  it('is a no-op when the history fits the budget', () => {
    const messages = [msg('hello'), msg('world')];
    const result = windowMessagesByBudget(messages, 1000);
    expect(result.messages).toEqual(messages);
    expect(result.dropped).toBe(0);
  });

  it('drops the oldest whole messages beyond the budget', () => {
    // Each message ≈ 25 est. tokens (100 latin chars).
    const messages = [msg('a'.repeat(100)), msg('b'.repeat(100)), msg('c'.repeat(100))];
    const result = windowMessagesByBudget(messages, 60);
    expect(result.dropped).toBe(1);
    expect(result.messages.map((m) => m.content[0])).toEqual(['b', 'c']);
    expect(result.estimatedTokens).toBe(50);
  });

  it('always keeps the newest message even when it alone exceeds the budget', () => {
    const messages = [msg('old'), msg('x'.repeat(4000))];
    const result = windowMessagesByBudget(messages, 100);
    expect(result.dropped).toBe(1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content[0]).toBe('x');
  });

  it('handles an empty history', () => {
    const result = windowMessagesByBudget([]);
    expect(result.messages).toEqual([]);
    expect(result.dropped).toBe(0);
    expect(result.estimatedTokens).toBe(0);
  });

  it('fallback budget leaves headroom for system prompt + tools in a 128k window', () => {
    expect(HISTORY_TOKEN_BUDGET).toBeLessThanOrEqual(100_000);
  });
});

describe('resolveHistoryBudget', () => {
  it('derives context window × threshold', () => {
    expect(resolveHistoryBudget(200_000, 0.3)).toBe(60_000);
  });

  it('defaults the threshold to 50%', () => {
    expect(DEFAULT_COMPACTION_THRESHOLD).toBe(0.5);
    expect(resolveHistoryBudget(1_000_000)).toBe(500_000);
  });

  it('falls back to the conservative budget when the model declares no window', () => {
    expect(resolveHistoryBudget(undefined)).toBe(HISTORY_TOKEN_BUDGET);
    expect(resolveHistoryBudget(0)).toBe(HISTORY_TOKEN_BUDGET);
  });
});
