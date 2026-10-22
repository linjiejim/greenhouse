/**
 * MCP and the Agent API count tool calls inside `executeProxyTool`, after every
 * proxy check passed and under the canonical tool id — a refused call is not a
 * tool call, and a legacy alias must not become a counter key of its own.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@greenhouse/utils/logger';

const increment = vi.hoisted(() => vi.fn());

vi.mock('@greenhouse/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@greenhouse/db')>()),
  getDb: () => ({ usageCounters: { increment } }),
}));

import { executeProxyTool, ProxyToolError } from '../tool-proxy.js';

const execute = vi.fn();
const registry = {
  knowledge_query: { execute },
  knowledge_mutation: { execute },
};

beforeEach(() => {
  vi.clearAllMocks();
  increment.mockResolvedValue(undefined);
  execute.mockResolvedValue({ ok: true });
});

describe('executeProxyTool usage counting', () => {
  it('counts one call under the given client', async () => {
    await expect(
      executeProxyTool(registry, 'knowledge_query', ['knowledge_query'], { action: 'tree' }, { usageClient: 'mcp' }),
    ).resolves.toEqual({ ok: true });
    expect(increment).toHaveBeenCalledWith('tool_call', 'knowledge_query', 'mcp');
  });

  it('counts a legacy alias under the canonical tool id', async () => {
    await executeProxyTool(
      registry,
      'search_team_knowledge',
      ['knowledge_query'],
      { query: 'x' },
      {
        usageClient: 'agent_api',
      },
    );
    expect(increment).toHaveBeenCalledWith('tool_call', 'knowledge_query', 'agent_api');
  });

  it('does not count a call the proxy refused', async () => {
    await expect(executeProxyTool(registry, 'knowledge_query', [], {}, { usageClient: 'mcp' })).rejects.toBeInstanceOf(
      ProxyToolError,
    );
    await expect(
      executeProxyTool(registry, 'knowledge_mutation', ['knowledge_mutation'], {}, { usageClient: 'mcp' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(increment).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not count internal evaluations that pass no client', async () => {
    await executeProxyTool(registry, 'knowledge_query', ['knowledge_query'], {});
    expect(increment).not.toHaveBeenCalled();
  });

  it('returns the tool output when the count fails', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    increment.mockRejectedValue(new Error('db down'));
    await expect(
      executeProxyTool(registry, 'knowledge_query', ['knowledge_query'], {}, { usageClient: 'mcp' }),
    ).resolves.toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
    warn.mockRestore();
  });
});
