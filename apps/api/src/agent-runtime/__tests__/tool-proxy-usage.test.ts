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

import { executeProxyTool, ProxyToolError, canonicalProxyToolId } from '../tool-proxy.js';

const execute = vi.fn();
const registry = {
  session_query: { execute },
  files_mutation: { execute },
};

beforeEach(() => {
  vi.clearAllMocks();
  increment.mockResolvedValue(undefined);
  execute.mockResolvedValue({ ok: true });
});

describe('executeProxyTool usage counting', () => {
  it('counts one call under the given client', async () => {
    await expect(
      executeProxyTool(registry, 'session_query', ['session_query'], { action: 'tree' }, { usageClient: 'mcp' }),
    ).resolves.toEqual({ ok: true });
    expect(increment).toHaveBeenCalledWith('tool_call', 'session_query', 'mcp');
  });

  it('counts a legacy alias under the canonical tool id', async () => {
    await executeProxyTool(
      registry,
      'session_history',
      ['session_query'],
      { query: 'x' },
      {
        usageClient: 'agent_api',
      },
    );
    expect(increment).toHaveBeenCalledWith('tool_call', 'session_query', 'agent_api');
  });

  it('does not count a call the proxy refused', async () => {
    await expect(executeProxyTool(registry, 'session_query', [], {}, { usageClient: 'mcp' })).rejects.toBeInstanceOf(
      ProxyToolError,
    );
    await expect(
      executeProxyTool(registry, 'files_mutation', ['files_mutation'], {}, { usageClient: 'mcp' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(increment).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not count internal evaluations that pass no client', async () => {
    await executeProxyTool(registry, 'session_query', ['session_query'], {});
    expect(increment).not.toHaveBeenCalled();
  });

  it('returns the tool output when the count fails', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    increment.mockRejectedValue(new Error('db down'));
    await expect(
      executeProxyTool(registry, 'session_query', ['session_query'], {}, { usageClient: 'mcp' }),
    ).resolves.toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
    warn.mockRestore();
  });
});

describe('canonicalProxyToolId', () => {
  it('names the tool a legacy alias runs as, so paged output keeps its real source', () => {
    expect(canonicalProxyToolId('session_history')).toBe('session_query');
    expect(canonicalProxyToolId('session_history')).toBe('session_query');
    expect(canonicalProxyToolId('tables_query')).toBe('tables_query');
  });
});
