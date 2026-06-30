/**
 * Tests for the web agent transport — the RuntimeEvent reducer.
 */

import { describe, it, expect } from 'vitest';
import { applyRuntimeEvent } from '../../apps/web/src/lib/agent-transport/runtime-event';
import { emptyStreamState, type RuntimeEvent } from '../../apps/web/src/lib/agent-transport/types';

function fold(events: RuntimeEvent[]) {
  return events.reduce(applyRuntimeEvent, emptyStreamState());
}

describe('applyRuntimeEvent', () => {
  it('accumulates text and reasoning deltas', () => {
    const s = fold([
      { type: 'reasoning-delta', text: 'think ' },
      { type: 'reasoning-delta', text: 'more' },
      { type: 'text-delta', text: 'Hello ' },
      { type: 'text-delta', text: 'world' },
    ]);
    expect(s.text).toBe('Hello world');
    expect(s.reasoning).toBe('think more');
  });

  it('tracks a tool call through start → delta → result', () => {
    const s = fold([
      { type: 'tool-call-start', toolCallId: 't1', toolName: 'read', args: '' },
      { type: 'tool-call-delta', toolCallId: 't1', toolName: 'read', partial: '{"path":' },
      { type: 'tool-call-delta', toolCallId: 't1', toolName: 'read', partial: '"/a"}' },
      { type: 'tool-result', toolCallId: 't1', toolName: 'read', result: { ok: true }, isError: false },
    ]);
    expect(s.toolCalls).toHaveLength(1);
    expect(s.toolCalls[0]).toMatchObject({ id: 't1', name: 'read', input: '{"path":"/a"}', status: 'done' });
    expect(s.toolCalls[0].output).toEqual({ ok: true });
  });

  it('stringifies non-string tool args/partials', () => {
    const s = fold([{ type: 'tool-call-start', toolCallId: 't', toolName: 'x', args: { a: 1 } }]);
    expect(s.toolCalls[0].input).toBe('{"a":1}');
  });

  it('records errors, finish, and permission requests; never mutates input', () => {
    const base = emptyStreamState();
    const afterErr = applyRuntimeEvent(base, { type: 'error', message: 'boom' });
    expect(afterErr.error).toBe('boom');
    expect(base.error).toBeNull(); // immutability

    const afterFinish = applyRuntimeEvent(base, { type: 'finish' });
    expect(afterFinish.finished).toBe(true);

    const afterPerm = applyRuntimeEvent(base, {
      type: 'local-permission-request',
      toolCallId: 'c',
      toolName: 'bash',
      action: 'run',
      detail: 'rm -rf',
    });
    expect(afterPerm.permissionRequest).toMatchObject({ toolName: 'bash', action: 'run' });
  });
});
