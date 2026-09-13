import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';
import {
  reconcileInterruptedChatRuntimeRuns,
  recordChatRuntimeProviderInput,
  checkpointChatRuntimeStream,
  settleChatRuntimeTrace,
  startChatRuntimeTrace,
} from '../../apps/api/src/chat-runtime.js';
import { instrumentRuntimeTools } from '../../apps/api/src/runtime/tool-evidence.js';

let db: DatabaseProvider;
let user: UserRow;

function unique(label: string): string {
  return `${label}:${Date.now()}:${Math.random()}`;
}

describe('ordinary Chat Runtime trace', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    user = await createInternalTestUser(db, { email: `${unique('chat-runtime')}@test.local` });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('persists exact input/provider/tool evidence and settles one chat_turn step', async () => {
    const exact = `do not truncate:${'x'.repeat(30_000)}`;
    const sourceId = unique('message');
    const input = {
      source_mode: 'message',
      triggering_user_message_id: sourceId,
      transcript: [{ role: 'user', content: exact }],
      provider_message_projection: [{ role: 'user', content: 'safe projection' }],
    };
    const session = await db.sessions.create('Runtime trace', 'team', user.id, undefined, 'web');
    const trace = await startChatRuntimeTrace(db, {
      ownerUserId: user.id,
      sessionId: session.id,
      sourceId,
      input,
    });
    const replayed = await startChatRuntimeTrace(db, {
      ownerUserId: user.id,
      sessionId: (await db.runtime.getRun(trace.runId))!.session_id!,
      sourceId,
      input,
    });
    expect(replayed).toEqual(trace);

    const providerEnvelope = {
      system_prompt: `full-system:${'s'.repeat(10_000)}`,
      messages: [{ role: 'user', content: 'safe projection' }],
      tool_ids: ['knowledge_query'],
    };
    await recordChatRuntimeProviderInput(db, trace, providerEnvelope);
    const rawToolOutput = { rows: [{ value: 'z'.repeat(25_000) }] };
    await settleChatRuntimeTrace(db, trace, {
      status: 'succeeded',
      output: {
        engine_result: { text: exact, pipelineSteps: [{ tool: 'knowledge_query', output: { compact: true } }] },
        raw_tool_evidence: [{ type: 'tool-result', id: 'call-1', output: rawToolOutput }],
      },
      tokensUsed: 321,
      durationMs: 456,
    });

    const detail = (await db.runtime.getRunDetail(trace.runId))!;
    expect(detail.run).toMatchObject({
      kind: 'chat',
      source_kind: 'chat_turn',
      source_id: sourceId,
      status: 'succeeded',
      max_attempts: 1,
    });
    expect(JSON.parse(detail.run.input)).toEqual(input);
    expect(JSON.parse(detail.run.output).raw_tool_evidence[0].output).toEqual(rawToolOutput);
    expect(detail.steps).toHaveLength(1);
    expect(detail.steps[0]).toMatchObject({
      step_key: 'chat_turn',
      kind: 'chat_turn',
      status: 'succeeded',
      tokens_used: 321,
      duration_ms: 456,
    });
    expect(JSON.parse(detail.steps[0]!.output!).raw_tool_evidence[0].output).toEqual(rawToolOutput);
    const providerEvent = detail.events.find((event) => event.type === 'chat.provider_input');
    expect(JSON.parse(providerEvent!.payload)).toEqual(providerEnvelope);
  });

  it('interrupts orphaned Chat traces at boot without claiming or replaying them', async () => {
    const session = await db.sessions.create('Interrupted trace', 'team', user.id, undefined, 'web');
    const trace = await startChatRuntimeTrace(db, {
      ownerUserId: user.id,
      sessionId: session.id,
      sourceId: unique('message'),
      input: { transcript: [{ role: 'user', content: 'lost process' }] },
    });
    const before = (await db.runtime.getRun(trace.runId))!;
    expect(before).toMatchObject({ status: 'running', attempt: 0, lease_owner: null });
    await checkpointChatRuntimeStream(db, trace, 0, { text: 'durable partial', reasoning: 'exact' });
    const tools = instrumentRuntimeTools(
      {
        knowledge_query: {
          description: 'test Runtime evidence',
          execute: async () => ({ rows: ['complete before crash'] }),
        },
      },
      {
        db,
        runId: trace.runId,
        stepId: trace.stepId,
        actorUserId: trace.actorUserId,
        executionAuthority: { mode: 'chat_projection' },
        idempotencyPrefix: 'chat',
        resolveRisk: () => 'r0',
      },
    );
    await tools.knowledge_query!.execute!({ query: 'exact input' }, { toolCallId: 'crash-call' } as never);

    await expect(reconcileInterruptedChatRuntimeRuns(db)).resolves.toBe(1);

    const after = (await db.runtime.getRun(trace.runId))!;
    const step = (await db.runtime.getStep(trace.stepId))!;
    expect(after).toMatchObject({
      status: 'interrupted',
      attempt: 0,
      lease_owner: null,
      error_code: 'chat_process_restarted',
    });
    expect(step).toMatchObject({ status: 'interrupted', lease_owner: null });
    expect(JSON.parse(after.output!)).toEqual(
      expect.objectContaining({
        reason: 'api_process_restart',
        replay_policy: 'never',
        last_stream_checkpoint: expect.objectContaining({ text: 'durable partial' }),
        tool_evidence: [expect.objectContaining({ tool_name: 'knowledge_query', status: 'succeeded' })],
      }),
    );
    expect(await db.sessions.getLatestMessage(session.id)).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('durable partial'),
    });
  });

  it('retains a stateless authenticated provider turn with a nullable session link', async () => {
    const trace = await startChatRuntimeTrace(db, {
      ownerUserId: user.id,
      sessionId: null,
      sourceId: unique('stateless'),
      input: { source_mode: 'stateless', transcript: [{ role: 'user', content: 'one-shot request' }] },
    });
    await settleChatRuntimeTrace(db, trace, {
      status: 'succeeded',
      output: { engine_result: { text: 'one-shot response' } },
      tokensUsed: 4,
    });

    const run = (await db.runtime.getRun(trace.runId))!;
    expect(run).toMatchObject({ kind: 'chat', source_kind: 'chat_turn', session_id: null, status: 'succeeded' });
  });

  it('terminalizes the trace when exact provider evidence cannot be persisted', async () => {
    const trace = await startChatRuntimeTrace(db, {
      ownerUserId: user.id,
      sessionId: null,
      sourceId: unique('provider-evidence-failure'),
      input: { source_mode: 'stateless', transcript: [{ role: 'user', content: 'evidence fence' }] },
    });
    await recordChatRuntimeProviderInput(db, trace, { model: 'first', system_prompt: 'one' });

    await expect(
      recordChatRuntimeProviderInput(db, trace, { model: 'different', system_prompt: 'two' }),
    ).rejects.toMatchObject({ code: 'runtime_idempotency_conflict' });

    expect(await db.runtime.getRun(trace.runId)).toMatchObject({
      status: 'failed',
      error_code: 'chat_provider_input_persistence_failed',
    });
    expect(await db.runtime.getStep(trace.stepId)).toMatchObject({ status: 'failed' });
  });
});
