/**
 * Local tool bridge — verifies the request/response round-trip that closes the
 * Desktop local-runtime loop (backend emits request → client posts result → model
 * receives the real output).
 */

import { describe, it, expect, vi } from 'vitest';
import { createLocalToolBridge } from '../local/bridge.js';
import { resolveLocalToolResult, waitForLocalToolResult } from '../local/pending.js';

describe('local tool bridge round-trip', () => {
  it('emits a local-tool-request and resolves with the client result', async () => {
    const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
    const toolCallId = 'call-1';
    const events: Record<string, unknown>[] = [];

    const bridge = createLocalToolBridge(sessionId);
    bridge.setWriter(async (event) => {
      events.push(event);
    });

    const execPromise = bridge.requestExecution('local_shell', { command: 'echo hi' }, toolCallId);

    // The request must reach the client immediately, before the result arrives.
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({
      type: 'local-tool-request',
      toolCallId,
      toolId: 'local_shell',
      params: { command: 'echo hi' },
    });

    // Simulate the Desktop client posting back the executed result. The pending
    // entry is registered just after the request is written, so poll until it lands.
    await vi.waitFor(() =>
      expect(resolveLocalToolResult(sessionId, toolCallId, { stdout: 'hi\n', exitCode: 0 })).toBe(true),
    );

    await expect(execPromise).resolves.toEqual({ stdout: 'hi\n', exitCode: 0 });
  });

  it('surfaces a client error as an { error } tool result', async () => {
    const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
    const bridge = createLocalToolBridge(sessionId);
    bridge.setWriter(async () => {});

    const execPromise = bridge.requestExecution('local_file_write', { path: '/x' }, 'call-2');
    await vi.waitFor(() =>
      expect(resolveLocalToolResult(sessionId, 'call-2', null, 'Permission denied by user')).toBe(true),
    );

    await expect(execPromise).resolves.toEqual({ error: 'Permission denied by user' });
  });

  it('returns an error when no stream writer is connected', async () => {
    const bridge = createLocalToolBridge('sess-x');
    await expect(bridge.requestExecution('local_shell', {}, 'call-3')).resolves.toEqual({
      error: 'Local runtime is not connected (Desktop stream unavailable).',
    });
  });

  it('resolveLocalToolResult returns false for an unknown request', () => {
    expect(resolveLocalToolResult('nope', 'nope', null)).toBe(false);
  });

  it('waitForLocalToolResult times out with an error', async () => {
    const result = await waitForLocalToolResult('sess-timeout', 'call-timeout', 20);
    expect(result.error).toMatch(/timed out/);
  });
});
