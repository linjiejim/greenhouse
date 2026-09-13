import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadPlatformTools } from './platform-tools.js';

describe('Sandbox Runner platform approval flow', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('never sends confirm:true and retries only after the lease is approved', async () => {
    vi.useFakeTimers();
    const bodies: Array<Record<string, unknown>> = [];
    let approvalPolls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime-manifest')) {
        return new Response(
          JSON.stringify({
            tools: [
              {
                id: 'crm_mutation',
                name: 'CRM mutation',
                description: 'Change CRM data',
                mutating: true,
                inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/approvals/')) {
        approvalPolls += 1;
        return new Response(JSON.stringify({ approval: { status: approvalPolls === 1 ? 'pending' : 'approved' } }), {
          status: 200,
        });
      }
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            error: { type: 'approval_required' },
            approval: { id: 'caa_test', tool_id: 'crm_mutation', action: 'update', expires_at: '2099-01-01' },
          }),
          { status: 428 },
        );
      }
      return new Response(JSON.stringify({ tool: 'crm_mutation', output: { ok: true } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const requested = vi.fn();
    const started = vi.fn();
    const completed = vi.fn();
    const tools = await loadPlatformTools('http://api', 'lpct_test', {
      onApprovalRequested: requested,
      onToolStarted: started,
      onToolCompleted: completed,
    });
    const tool = tools[0] as unknown as {
      execute(callId: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
    };

    const executing = tool.execute('call-1', { action: 'update' });
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await executing;

    expect(requested).toHaveBeenCalledWith({
      id: 'caa_test',
      tool: 'crm_mutation',
      action: 'update',
      expires_at: '2099-01-01',
    });
    expect(bodies).toEqual([{ input: { action: 'update' } }, { input: { action: 'update' }, approval_id: 'caa_test' }]);
    expect(JSON.stringify(bodies)).not.toContain('confirm');
    expect(started).toHaveBeenCalledWith({ tool: 'crm_mutation', args: { action: 'update' } });
    expect(completed).toHaveBeenCalledWith({
      tool: 'crm_mutation',
      is_error: false,
      result: JSON.stringify({ tool: 'crm_mutation', output: { ok: true } }),
    });
  });

  it('audits the full platform-tool result before clipping model context', async () => {
    const fullResult = JSON.stringify({ output: 'x'.repeat(64_000) });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              tools: [
                {
                  id: 'knowledge_search',
                  name: 'Knowledge search',
                  description: 'Search',
                  mutating: false,
                  inputSchema: { type: 'object' },
                },
              ],
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response(fullResult, { status: 200 })),
    );
    const completed = vi.fn();
    const [tool] = await loadPlatformTools('http://api', 'lpct_test', { onToolCompleted: completed });
    const result = await (
      tool as unknown as { execute(callId: string, params: unknown, signal?: AbortSignal): Promise<unknown> }
    ).execute('call-1', { query: 'full result' });

    expect(completed).toHaveBeenCalledWith({ tool: 'knowledge_search', is_error: false, result: fullResult });
    expect(JSON.stringify(result)).toContain('[clipped]');
  });
});
