import { describe, expect, it, vi } from 'vitest';
import { instrumentRuntimeTools, settleOpenRuntimeToolCalls } from './tool-evidence.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(options: { beginGate?: Promise<void>; rejectTerminal?: boolean; rejectUncertain?: boolean } = {}) {
  const order: string[] = [];
  let row: any;
  let rejectTerminal = options.rejectTerminal === true;
  const beginToolCallWithAuthority = vi.fn(async (input: any) => {
    order.push('db:begin:start');
    await options.beginGate;
    order.push('db:begin:done');
    row = {
      id: 'rtc-1',
      run_id: input.run_id,
      step_id: input.step_id,
      tool_name: input.tool_name,
      status: 'running',
      input: JSON.stringify(input.input),
      output: null,
      canonical_input_hash: input.canonical_input_hash,
      risk_level: input.risk_level,
      idempotency_key: input.idempotency_key,
      interrupt_id: null,
      platform_audit_event_id: null,
      error_code: null,
      error_message: null,
      started_at: null,
      ended_at: null,
      created_at: '2026-08-12T00:00:00.000Z',
      updated_at: '2026-08-12T00:00:00.000Z',
      version: 2,
    };
    return row;
  });
  const transitionToolCall = vi.fn(async (input: any) => {
    order.push(`db:${input.to_status}`);
    if (rejectTerminal && (input.to_status === 'succeeded' || input.to_status === 'failed')) {
      rejectTerminal = false;
      throw new Error('terminal persistence unavailable');
    }
    if (options.rejectUncertain && input.to_status === 'uncertain') {
      throw new Error('uncertain persistence unavailable');
    }
    row = {
      ...row,
      status: input.to_status,
      output: input.output === undefined ? row.output : JSON.stringify(input.output),
      error_code: input.error_code ?? null,
      error_message: input.error_message ?? null,
      version: row.version + 1,
    };
    return row;
  });
  const db = {
    runtime: {
      beginToolCallWithAuthority,
      transitionToolCall,
      getToolCall: vi.fn(async () => row),
      listToolCalls: vi.fn(async () => (row ? [row] : [])),
    },
  };
  return { beginToolCallWithAuthority, db, order, transitionToolCall };
}

function wrap(db: ReturnType<typeof fixture>['db'], execute: (input: unknown, options: unknown) => unknown) {
  return instrumentRuntimeTools(
    { sample_tool: { description: 'test', execute } },
    {
      db: db as never,
      runId: 'run-1',
      stepId: 'step-1',
      actorUserId: 'user-1',
      executionAuthority: { mode: 'leased', workerId: 'worker-1', leaseMs: 30_000 },
      idempotencyPrefix: 'test',
      resolveRisk: () => 'r2',
    },
  ).sample_tool as { execute: (input: unknown, options: unknown) => Promise<unknown> };
}

describe('Runtime live ToolCall evidence', () => {
  it('awaits the durable running row before entering the real tool execute', async () => {
    const gate = deferred();
    const state = fixture({ beginGate: gate.promise });
    const execute = vi.fn(async () => {
      state.order.push('tool:execute');
      return { content: 'complete output' };
    });
    const tool = wrap(state.db, execute);

    const pending = tool.execute({ query: 'full input' }, { toolCallId: 'call-1' });
    await Promise.resolve();
    expect(state.order).toEqual(['db:begin:start']);
    expect(execute).not.toHaveBeenCalled();

    gate.resolve();
    await expect(pending).resolves.toEqual({ content: 'complete output' });
    expect(state.order).toEqual(['db:begin:start', 'db:begin:done', 'tool:execute', 'db:succeeded']);
    expect(state.beginToolCallWithAuthority).toHaveBeenCalledWith(
      expect.objectContaining({
        run_id: 'run-1',
        step_id: 'step-1',
        tool_name: 'sample_tool',
        input: { query: 'full input' },
        risk_level: 'r2',
        idempotency_key: 'test:call-1',
        worker_id: 'worker-1',
        lease_ms: 30_000,
      }),
    );
  });

  it('never executes a tool when the before-execution evidence write fails', async () => {
    const state = fixture();
    state.db.runtime.beginToolCallWithAuthority = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const execute = vi.fn(async () => ({ should: 'not happen' }));
    const tool = wrap(state.db, execute);

    await expect(tool.execute({ secret: 'kept' }, { toolCallId: 'call-before-fails' })).rejects.toThrow(
      'database unavailable',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['cancel was committed', 'lease already expired'])(
    'never executes after authority admission rejects because %s',
    async (reason) => {
      const state = fixture();
      state.db.runtime.beginToolCallWithAuthority = vi.fn().mockRejectedValue(new Error(reason));
      const execute = vi.fn(async () => ({ should: 'not happen' }));
      const tool = wrap(state.db, execute);

      await expect(tool.execute({}, { toolCallId: `call-${reason}` })).rejects.toThrow(reason);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('never persists or executes a provider-queued tool after its Chat abort signal was acknowledged', async () => {
    const state = fixture();
    const execute = vi.fn(async () => ({ should: 'not happen' }));
    const tool = wrap(state.db, execute);
    const abort = new AbortController();
    abort.abort(new Error('user stopped Chat'));

    await expect(tool.execute({}, { toolCallId: 'call-after-stop', abortSignal: abort.signal })).rejects.toThrow(
      'user stopped Chat',
    );
    expect(state.beginToolCallWithAuthority).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('cancels without executing when Chat stops while durable admission is still waiting', async () => {
    const gate = deferred();
    const state = fixture({ beginGate: gate.promise });
    const execute = vi.fn(async () => ({ should: 'not happen' }));
    const tool = wrap(state.db, execute);
    const abort = new AbortController();

    const pending = tool.execute({}, { toolCallId: 'call-stop-during-begin', abortSignal: abort.signal });
    await Promise.resolve();
    abort.abort(new Error('user stopped during admission'));
    gate.resolve();

    await expect(pending).rejects.toThrow('user stopped during admission');
    expect(execute).not.toHaveBeenCalled();
    expect(state.transitionToolCall).toHaveBeenLastCalledWith(
      expect.objectContaining({ to_status: 'canceled', error_code: 'tool_canceled' }),
    );
  });

  it('persists an untruncated exact success output before returning it', async () => {
    const state = fixture();
    const output = { content: 'x'.repeat(50_000), nested: { all: ['values', 7, true] } };
    const tool = wrap(
      state.db,
      vi.fn(async () => output),
    );

    await expect(tool.execute({ full: { input: 'y'.repeat(20_000) } }, { toolCallId: 'call-success' })).resolves.toBe(
      output,
    );
    expect(state.transitionToolCall).toHaveBeenLastCalledWith(
      expect.objectContaining({ to_status: 'succeeded', output }),
    );
  });

  it('persists full thrown error evidence and marks the ToolCall failed', async () => {
    const state = fixture();
    const thrown = new Error('upstream rejected exact request');
    const tool = wrap(
      state.db,
      vi.fn(async () => {
        throw thrown;
      }),
    );

    await expect(tool.execute({ target: 'customer-42' }, { toolCallId: 'call-error' })).rejects.toBe(thrown);
    expect(state.transitionToolCall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        to_status: 'failed',
        error_code: 'tool_failed',
        error_message: 'upstream rejected exact request',
        output: {
          error: expect.objectContaining({
            name: 'Error',
            message: 'upstream rejected exact request',
            stack: expect.any(String),
          }),
        },
      }),
    );
  });

  it('treats an explicit tool error result as failed while returning the exact result to the model', async () => {
    const state = fixture();
    const output = { error: 'record is locked', owner: { id: 'u-2' } };
    const tool = wrap(
      state.db,
      vi.fn(async () => output),
    );

    await expect(tool.execute({}, { toolCallId: 'call-returned-error' })).resolves.toBe(output);
    expect(state.transitionToolCall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        to_status: 'failed',
        output,
        error_code: 'tool_returned_error',
        error_message: 'record is locked',
      }),
    );
  });

  it('marks the observed outcome uncertain if terminal persistence fails after execute', async () => {
    const state = fixture({ rejectTerminal: true });
    const output = { external_id: 'already-created' };
    const execute = vi.fn(async () => output);
    const tool = wrap(state.db, execute);

    await expect(tool.execute({}, { toolCallId: 'call-uncertain' })).rejects.toThrow(
      'terminal persistence unavailable',
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(state.transitionToolCall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        to_status: 'uncertain',
        output,
        error_code: 'tool_outcome_persistence_failed',
      }),
    );
  });

  it('never rewrites a successful external result as tool_failed when all outcome persistence is unavailable', async () => {
    const state = fixture({ rejectTerminal: true, rejectUncertain: true });
    const execute = vi.fn(async () => ({ external_id: 'already-created' }));
    const tool = wrap(state.db, execute);

    await expect(tool.execute({}, { toolCallId: 'call-all-terminal-writes-fail' })).rejects.toThrow(
      'terminal persistence unavailable',
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(state.transitionToolCall.mock.calls.map(([input]) => input.to_status)).toEqual(['succeeded', 'uncertain']);
  });

  it('keeps a running ToolCall uncertain after worker loss even when its Run was canceled', async () => {
    const state = fixture();
    const transition = vi.fn().mockResolvedValue({ id: 'rtc-open', status: 'uncertain', version: 8 });
    state.db.runtime.transitionToolCall = transition;
    state.db.runtime.listToolCalls = vi.fn().mockResolvedValue([{ id: 'rtc-open', status: 'running', version: 7 }]);

    await settleOpenRuntimeToolCalls(state.db as never, 'run-1', 'canceled', 'user-1');

    expect(transition).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'rtc-open',
        expected_version: 7,
        to_status: 'uncertain',
        error_code: 'tool_outcome_unknown',
      }),
    );
  });
});
