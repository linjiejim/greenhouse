/**
 * Module usage counting must never fail or delay the thing it counts.
 * These pin the fire-and-forget contract and the client attribution rules.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import {
  agentApiToolCallClient,
  chatToolCallClient,
  countToolCalls,
  countUsage,
  pageOpenClient,
  usageDayRange,
} from '../counters.js';

function fakeDb(increment: (...args: unknown[]) => Promise<void>): () => DatabaseProvider {
  return () => ({ usageCounters: { increment } }) as unknown as DatabaseProvider;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('countUsage', () => {
  it('writes one increment without being awaited', () => {
    const increment = vi.fn().mockResolvedValue(undefined);
    expect(countUsage('tool_call', 'knowledge_query', 'mcp', fakeDb(increment))).toBeUndefined();
    expect(increment).toHaveBeenCalledWith('tool_call', 'knowledge_query', 'mcp');
  });

  it('logs and swallows a rejected write', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    countUsage('page_open', 'chat', 'web', fakeDb(vi.fn().mockRejectedValue(new Error('db down'))));
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });

  it('logs and swallows a provider that throws synchronously', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(() =>
      countUsage('tool_call', 'x', 'mcp', () => {
        throw new Error('Database not initialized');
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Database not initialized'));
  });
});

describe('countToolCalls', () => {
  it('counts each execution under the given client and returns the original result', async () => {
    const increment = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const shared = { knowledge_query: { description: 'd', execute }, plain: { description: 'no execute' } };

    const counted = countToolCalls(shared, 'web_chat', fakeDb(increment));
    await expect(counted.knowledge_query.execute({ q: 1 }, { toolCallId: 't1' })).resolves.toEqual({ ok: true });
    await counted.knowledge_query.execute({ q: 2 }, { toolCallId: 't2' });

    expect(increment).toHaveBeenCalledTimes(2);
    expect(increment).toHaveBeenCalledWith('tool_call', 'knowledge_query', 'web_chat');
    expect(execute).toHaveBeenNthCalledWith(1, { q: 1 }, { toolCallId: 't1' });
    expect(counted.plain).toBe(shared.plain);
    // The shared registry is never mutated.
    expect(shared.knowledge_query.execute).toBe(execute);
  });

  it('still runs the tool when the count fails', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const execute = vi.fn().mockResolvedValue('result');
    const counted = countToolCalls({ t: { execute } }, 'automation', fakeDb(vi.fn().mockRejectedValue(new Error('x'))));
    await expect(counted.t.execute({}, { toolCallId: 'a' })).resolves.toBe('result');

    const throwing = countToolCalls({ t: { execute } }, 'automation', () => {
      throw new Error('no db');
    });
    await expect(throwing.t.execute({}, { toolCallId: 'b' })).resolves.toBe('result');
  });

  it('does not wait for a slow count', async () => {
    const execute = vi.fn().mockResolvedValue('fast');
    const never = new Promise<void>(() => undefined);
    const counted = countToolCalls(
      { t: { execute } },
      'subagent',
      fakeDb(() => never),
    );
    await expect(counted.t.execute({}, { toolCallId: 'c' })).resolves.toBe('fast');
  });

  it('propagates the tool’s own failure unchanged', async () => {
    const boom = new Error('tool failed');
    const counted = countToolCalls(
      { t: { execute: vi.fn().mockRejectedValue(boom) } },
      'mcp',
      fakeDb(vi.fn().mockResolvedValue(undefined)),
    );
    await expect(counted.t.execute({}, { toolCallId: 'd' })).rejects.toBe(boom);
  });
});

describe('client attribution', () => {
  it('chat turns follow the session channel, then the app header', () => {
    expect(chatToolCallClient('browser', null)).toBe('browser');
    expect(chatToolCallClient('feishu', 'mobile')).toBe('feishu');
    expect(chatToolCallClient('web', 'mobile')).toBe('mobile');
    expect(chatToolCallClient(undefined, null)).toBe('web_chat');
  });

  it('agent API calls from the first-party apps count as those apps', () => {
    expect(agentApiToolCallClient(null)).toBe('agent_api');
    expect(agentApiToolCallClient('mobile')).toBe('mobile');
  });

  it('page opens default to the web app', () => {
    expect(pageOpenClient(null)).toBe('web');
    expect(pageOpenClient('mobile')).toBe('mobile');
  });
});

describe('usageDayRange', () => {
  it('covers exactly `days` UTC days ending today', () => {
    const now = new Date('2026-10-23T01:00:00.000Z');
    expect(usageDayRange(7, now)).toEqual({ from: '2026-10-17', to: '2026-10-23' });
    expect(usageDayRange(30, now)).toEqual({ from: '2026-09-24', to: '2026-10-23' });
    expect(usageDayRange(90, now)).toEqual({ from: '2026-07-26', to: '2026-10-23' });
  });
});
