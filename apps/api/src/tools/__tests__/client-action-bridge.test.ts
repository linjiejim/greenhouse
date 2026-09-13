/** Browser client-action bridge request/result round-trip. */

import { describe, expect, it, vi } from 'vitest';
import { createClientActionBridge } from '../client-action-bridge.js';
import { resolveClientActionResult, waitForClientActionResult } from '../client-action-pending.js';

describe('client action bridge round-trip', () => {
  it('emits the compatibility wire event and resolves with the browser result', async () => {
    const userId = 'user-a';
    const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
    const toolCallId = 'call-1';
    const events: Record<string, unknown>[] = [];

    const bridge = createClientActionBridge(userId, sessionId);
    bridge.setWriter(async (event) => {
      events.push(event);
    });

    const execution = bridge.requestExecution('crm_navigate', { module: 'deals' }, toolCallId);

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({
      type: 'local-tool-request',
      toolCallId,
      toolId: 'crm_navigate',
      params: { module: 'deals' },
    });

    await vi.waitFor(() => expect(resolveClientActionResult(userId, sessionId, toolCallId, { ok: true })).toBe(true));
    await expect(execution).resolves.toEqual({ ok: true });
  });

  it('carries the page scope that advertised the action', async () => {
    const userId = 'user-scoped';
    const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
    const toolCallId = 'call-scoped';
    const events: Record<string, unknown>[] = [];
    const bridge = createClientActionBridge(userId, sessionId, 'page:crm/deals');
    bridge.setWriter(async (event) => {
      events.push(event);
    });

    const execution = bridge.requestExecution('crm_navigate', { module: 'deals' }, toolCallId);
    await vi.waitFor(() =>
      expect(events[0]).toMatchObject({
        type: 'local-tool-request',
        toolCallId,
        scopeId: 'page:crm/deals',
      }),
    );
    expect(resolveClientActionResult(userId, sessionId, toolCallId, { ok: true })).toBe(true);
    await expect(execution).resolves.toEqual({ ok: true });
  });

  it('does not let another internal user resolve a pending action', async () => {
    const bridge = createClientActionBridge('owner', 'sess-owned');
    bridge.setWriter(async () => {});
    const execution = bridge.requestExecution('crm_prefill', { title: 'Lead' }, 'call-owned');

    await vi.waitFor(() => {
      expect(resolveClientActionResult('attacker', 'sess-owned', 'call-owned', { ok: true })).toBe(false);
      expect(resolveClientActionResult('owner', 'sess-owned', 'call-owned', null, 'Rejected by user')).toBe(true);
    });
    await expect(execution).resolves.toEqual({ error: 'Rejected by user' });
  });

  it('returns a clear error when no browser stream is connected', async () => {
    const bridge = createClientActionBridge('user-a', 'sess-x');
    await expect(bridge.requestExecution('crm_navigate', {}, 'call-3')).resolves.toEqual({
      error: 'Client action stream is not connected.',
    });
  });

  it('returns false for an unknown result and times out pending actions', async () => {
    expect(resolveClientActionResult('user-a', 'missing', 'missing', null)).toBe(false);
    const result = await waitForClientActionResult('user-a', 'sess-timeout', 'call-timeout', 20);
    expect(result.error).toMatch(/timed out/);
  });
});
