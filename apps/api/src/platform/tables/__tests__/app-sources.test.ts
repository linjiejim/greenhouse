import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
import { APP_SOURCE_LIMITS } from '@greenhouse/types/apps';
const mocks = vi.hoisted(() => ({ allowed: ['project_query'], execute: vi.fn(), connector: vi.fn() }));
vi.mock('../../../agent.js', () => ({
  resolveUserTools: async () => ({ allowedTools: mocks.allowed }),
  createToolRegistry: () => ({ project_query: { execute: mocks.execute } }),
}));
vi.mock('../../../tools/registry.js', () => ({
  WORKBENCH_READ_TOOL_IDS: new Set(['project_query']),
  MUTATING_PROXY_ALLOWLIST: new Set(),
  READONLY_PROXY_ALLOWLIST: new Set(),
}));
vi.mock('../../../agent-runtime/tool-resolution.js', () => ({ buildLazyServerTools: () => ({}) }));
vi.mock('../../../mcp-client/gateway.js', () => ({ callConnectorTool: mocks.connector }));
import { evaluateAppSource, mapAppSource } from '../app-sources.js';
const db = {
  users: { getById: async (id: string) => ({ id, role: 'team', status: 'active' }) },
} as unknown as DatabaseProvider;
beforeEach(() => {
  mocks.allowed = ['project_query'];
  mocks.execute.mockReset();
  mocks.connector.mockReset();
});
describe('external card sources', () => {
  it('maps pointers and caps rows without interpreting HTML', () => {
    const result = mapAppSource(
      { rows: Array.from({ length: 201 }, () => ({ title: '<script>1</script>' })) },
      { kind: 'table', rows: '/rows', columns: [{ key: 'title', label: 'Title', path: '/title' }] },
    );
    expect(result).toMatchObject({ kind: 'table', truncated: true });
    if (result.kind !== 'table') throw new Error();
    expect(result.rows).toHaveLength(200);
    expect(result.rows[0]?.title).toBe('<script>1</script>');
    expect(mapAppSource({ 'a/b': ['x'] }, { kind: 'kpi', value: '/a~1b' })).toEqual({ kind: 'kpi', value: 1 });
    expect(mapAppSource({ count: null }, { kind: 'kpi', value: '/count' })).toMatchObject({ reason: 'map' });
    expect(mapAppSource('x'.repeat(APP_SOURCE_LIMITS.resultBytes + 1), { kind: 'kpi', value: '' })).toMatchObject({
      reason: 'too_large',
    });
  });
  it('uses the viewer tool intersection and never executes unavailable or write tools', async () => {
    mocks.execute.mockResolvedValue({ total: 3 });
    const source = {
      kind: 'tool' as const,
      toolId: 'project_query',
      input: { action: 'list' },
      map: { kind: 'kpi' as const, value: '/total' },
    };
    expect(await evaluateAppSource(db, 'viewer', source)).toEqual({ kind: 'kpi', value: 3 });
    expect(mocks.execute).toHaveBeenCalledWith(
      { action: 'list' },
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    mocks.allowed = [];
    expect(await evaluateAppSource(db, 'viewer', source)).toMatchObject({ reason: 'not_allowed' });
    mocks.allowed = ['project_mutation'];
    expect(await evaluateAppSource(db, 'viewer', { ...source, toolId: 'project_mutation' })).toMatchObject({
      reason: 'not_allowed',
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it('uses the viewer connector account and returns the connection card', async () => {
    mocks.allowed = ['mcp_call'];
    const connection = {
      needs_connection: true,
      server: 'crm',
      server_id: 2,
      server_name: 'CRM',
      auth: 'oauth',
      reason: 'not_connected',
      error: 'Connect',
    };
    mocks.connector.mockResolvedValue(connection);
    expect(
      await evaluateAppSource(db, 'viewer', {
        kind: 'connector',
        server: 'crm',
        tool: 'list',
        input: {},
        map: { kind: 'kpi', value: '' },
      }),
    ).toEqual({ kind: 'needs_connection', connection });
    expect(mocks.connector.mock.calls[0]?.[1]).toEqual({ userId: 'viewer' });
  });
  it('bounds wall clock and signals cancellation', async () => {
    vi.useFakeTimers();
    try {
      mocks.execute.mockImplementation(() => new Promise(() => {}));
      const result = evaluateAppSource(db, 'viewer', {
        kind: 'tool',
        toolId: 'project_query',
        input: {},
        map: { kind: 'kpi', value: '' },
      });
      await vi.advanceTimersByTimeAsync(APP_SOURCE_LIMITS.timeoutMs);
      expect(await result).toMatchObject({ reason: 'timeout' });
      expect(mocks.execute.mock.calls[0]?.[1].abortSignal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
