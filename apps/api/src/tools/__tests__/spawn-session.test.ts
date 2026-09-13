/**
 * Unit tests for the session-orchestration tools: spawn_session + call_llm.
 *
 * These run with a fake in-memory db and a stubbed LLM (the `generate` seam), so
 * no Postgres or provider API key is needed. They cover the behavior the feature
 * promises: child lineage, the call_llm audit log, sync/async, the confirm gate,
 * and the bounded-recursion guard.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createSpawnSessionTool } from '../spawn-session.js';
import { createCallLlmTool } from '../call-llm.js';
import { getAllToolIds, getToolMeta } from '../registry.js';
import { LAZY_TOOL_IDS, childSpawnToolIds } from '../../agent-runtime/tool-resolution.js';
import { MAX_SPAWN_DEPTH } from '../spawn-session.js';

// ─── Fake db ─────────────────────────────────────────────

function makeFakeDb() {
  const sessions = new Map<string, any>();
  const messages: any[] = [];
  const llmCalls: any[] = [];
  const budgetReservations: any[] = [];
  const budgetSettlements: any[] = [];
  const budgetReleases: any[] = [];
  const usageRows: any[] = [];
  const runtimeRuns = new Map<string, any>();
  const runtimeSteps = new Map<string, any>();
  let seq = 0;
  let runtimeSeq = 0;

  const api: any = {
    _sessions: sessions,
    _messages: messages,
    _llmCalls: llmCalls,
    _budgetReservations: budgetReservations,
    _budgetSettlements: budgetSettlements,
    _budgetReleases: budgetReleases,
    _usageRows: usageRows,
    _runtimeRuns: runtimeRuns,
    _runtimeSteps: runtimeSteps,
    users: {
      async getById(id: string) {
        return { id, role: 'team', status: 'active', monthly_token_limit: 1_000_000 };
      },
    },
    usageBudget: {
      async reserveMonthlyUser(input: any) {
        budgetReservations.push(input);
      },
      async settle(input: any) {
        budgetSettlements.push(input);
      },
      async release(input: any) {
        budgetReleases.push(input);
      },
    },
    usage: {
      async record(input: any) {
        usageRows.push(input);
      },
    },
    sessions: {
      async create(
        title?: string,
        profileId?: string,
        userId?: string,
        appId?: string,
        channel?: string,
        parentSessionId?: string,
      ) {
        const id = `s_${++seq}`;
        const row = {
          id,
          title: title ?? null,
          status: 'active',
          profile_id: profileId ?? 'team',
          user_id: userId ?? null,
          app_id: appId ?? null,
          channel: channel ?? 'web',
          parent_session_id: parentSessionId ?? null,
          metadata: '{}',
          created_at: '2026-06-18T00:00:00Z',
          updated_at: '2026-06-18T00:00:00Z',
        };
        sessions.set(id, row);
        return row;
      },
      async getById(id: string) {
        return sessions.get(id);
      },
      async update(id: string, updates: any) {
        const row = sessions.get(id);
        if (row) Object.assign(row, updates);
        return row;
      },
      async addMessage(input: any) {
        const row = { id: `m_${messages.length + 1}`, ...input };
        messages.push(row);
        return row;
      },
      async addMessageOnce(id: string, input: any) {
        const existing = messages.find((message) => message.id === id);
        if (existing) return existing;
        const row = { id, ...input };
        messages.push(row);
        return row;
      },
      async getLatestMessage(sessionId: string) {
        return messages.filter((message) => message.session_id === sessionId).at(-1);
      },
      async appendAssistantIfTail(sessionId: string, expectedTail: { id: string; content: string }, input: any) {
        const latest = messages.filter((message) => message.session_id === sessionId).at(-1);
        if (!latest || latest.id !== expectedTail.id || latest.content !== expectedTail.content) {
          return { ok: false, reason: 'transcript_changed' as const };
        }
        const row = { id: `m_${messages.length + 1}`, ...input };
        messages.push(row);
        return { ok: true, message: row };
      },
      async touch() {},
    },
    llmCalls: {
      async record(input: any) {
        const row = { id: `l_${llmCalls.length + 1}`, ...input };
        llmCalls.push(row);
        return row;
      },
    },
    runtime: {
      async admitSubagent(input: any) {
        const existingRun = [...runtimeRuns.values()].find(
          (run) => run.kind === 'subagent' && run.source_id === input.child_session_id,
        );
        if (existingRun) {
          return {
            session: sessions.get(input.child_session_id),
            message: messages.find((message) => message.id === input.seed_message_id),
            run: existingRun,
            step: [...runtimeSteps.values()].find((step) => step.run_id === existingRun.id),
            idempotent: true,
          };
        }
        const now = '2026-06-18T00:00:00.000Z';
        const session = {
          id: input.child_session_id,
          title: input.title,
          status: 'active',
          profile_id: input.profile_id,
          user_id: input.owner_user_id,
          app_id: null,
          channel: 'subagent',
          parent_session_id: input.parent_session_id,
          metadata: JSON.stringify(input.metadata),
          created_at: now,
          updated_at: now,
        };
        sessions.set(session.id, session);
        const message = {
          id: input.seed_message_id,
          session_id: session.id,
          role: 'user',
          content: input.prompt,
        };
        messages.push(message);
        const run = await api.runtime.createRun({
          kind: 'subagent',
          owner_user_id: input.owner_user_id,
          initiated_by_user_id: input.initiated_by_user_id,
          session_id: session.id,
          parent_run_id: input.parent_run_id,
          source_kind: 'spawned_session',
          source_id: session.id,
          idempotency_key: `spawned-session:${session.id}`,
          max_attempts: 1,
          input: {
            child_session_id: session.id,
            parent_session_id: input.parent_session_id,
            profile_id: input.profile_id,
            prompt: input.prompt,
            title: input.title,
            depth: input.depth,
            max_steps: input.max_steps,
            mode: input.mode,
            timeout_ms: input.timeout_ms,
            workspace_id: input.workspace_id,
          },
        });
        const step = await api.runtime.createStep({
          run_id: run.id,
          step_key: 'agent-turn',
          kind: 'subagent_turn',
          input: {
            child_session_id: session.id,
            prompt: input.prompt,
            profile_id: input.profile_id,
            max_steps: input.max_steps,
          },
        });
        return { session, message, run, step, idempotent: false };
      },
      async countActiveSubagentRuns(parentSessionId: string, ownerUserId?: string) {
        return [...runtimeRuns.values()].filter((run) => {
          const input = JSON.parse(run.input);
          return (
            run.kind === 'subagent' &&
            run.source_kind === 'spawned_session' &&
            ['queued', 'claimed', 'running', 'waiting', 'paused'].includes(run.status) &&
            input.parent_session_id === parentSessionId &&
            (!ownerUserId || run.owner_user_id === ownerUserId)
          );
        }).length;
      },
      async findActiveRunBySession() {
        return undefined;
      },
      async createRun(input: any) {
        const existing = [...runtimeRuns.values()].find(
          (run) =>
            run.kind === input.kind && run.source_kind === input.source_kind && run.source_id === input.source_id,
        );
        if (existing) return existing;
        const id = `rtr_${++runtimeSeq}`;
        const now = '2026-06-18T00:00:00.000Z';
        const row = {
          id,
          kind: input.kind,
          owner_user_id: input.owner_user_id,
          initiated_by_user_id: input.initiated_by_user_id,
          session_id: input.session_id ?? null,
          parent_run_id: input.parent_run_id ?? null,
          root_run_id: input.parent_run_id ?? id,
          source_kind: input.source_kind,
          source_id: input.source_id,
          idempotency_key: input.idempotency_key ?? null,
          priority: input.priority ?? 0,
          status: 'queued',
          desired_state: 'run',
          wait_reason: null,
          attempt: 0,
          max_attempts: input.max_attempts ?? 3,
          input: JSON.stringify(input.input),
          output: null,
          error_code: null,
          error_message: null,
          not_before: null,
          deadline_at: null,
          lease_owner: null,
          lease_expires_at: null,
          heartbeat_at: null,
          started_at: null,
          ended_at: null,
          settled_at: null,
          created_at: now,
          updated_at: now,
          version: 1,
        };
        runtimeRuns.set(id, row);
        return row;
      },
      async getRun(id: string) {
        return runtimeRuns.get(id);
      },
      async createStep(input: any) {
        const existing = [...runtimeSteps.values()].find(
          (step) => step.run_id === input.run_id && step.step_key === input.step_key && step.attempt === 1,
        );
        if (existing) return existing;
        const id = `rts_${++runtimeSeq}`;
        const now = '2026-06-18T00:00:00.000Z';
        const row = {
          id,
          run_id: input.run_id,
          parent_step_id: null,
          step_key: input.step_key,
          kind: input.kind,
          attempt: 1,
          status: 'queued',
          input: JSON.stringify(input.input),
          output: null,
          error_code: null,
          error_message: null,
          lease_owner: null,
          lease_expires_at: null,
          heartbeat_at: null,
          tokens_used: 0,
          requests_used: 0,
          cost_micros: 0,
          duration_ms: null,
          started_at: null,
          ended_at: null,
          created_at: now,
          updated_at: now,
          version: 1,
        };
        runtimeSteps.set(id, row);
        return row;
      },
      async getStep(id: string) {
        return runtimeSteps.get(id);
      },
      async listSteps(runId: string) {
        return [...runtimeSteps.values()].filter((step) => step.run_id === runId);
      },
      async claimExecution(input: any) {
        const run = runtimeRuns.get(input.run_id);
        const step = runtimeSteps.get(input.step_id);
        if (!run || !step || run.status !== 'queued' || step.status !== 'queued') return undefined;
        Object.assign(run, {
          status: 'claimed',
          attempt: run.attempt + 1,
          lease_owner: input.worker_id,
          lease_expires_at: new Date(Date.now() + input.lease_ms).toISOString(),
          version: run.version + 1,
        });
        Object.assign(step, {
          status: 'claimed',
          lease_owner: input.worker_id,
          lease_expires_at: new Date(Date.now() + input.lease_ms).toISOString(),
          version: step.version + 1,
        });
        return { run, step };
      },
      async transitionRun(input: any) {
        const run = runtimeRuns.get(input.id);
        Object.assign(run, {
          status: input.to_status,
          desired_state: input.desired_state ?? run.desired_state,
          output: input.output === undefined ? run.output : JSON.stringify(input.output),
          error_code: input.error_code ?? run.error_code,
          error_message: input.error_message ?? run.error_message,
          version: run.version + 1,
        });
        return run;
      },
      async transitionStep(input: any) {
        const step = runtimeSteps.get(input.id);
        Object.assign(step, {
          status: input.to_status,
          output: input.output === undefined ? step.output : JSON.stringify(input.output),
          error_code: input.error_code ?? step.error_code,
          error_message: input.error_message ?? step.error_message,
          tokens_used: input.tokens_used ?? step.tokens_used,
          requests_used: input.requests_used ?? step.requests_used,
          duration_ms: input.duration_ms ?? step.duration_ms,
          version: step.version + 1,
        });
        return step;
      },
      async createToolCall() {
        throw new Error('unexpected tool evidence in this test');
      },
    },
  };
  return api as any;
}

/** Seed a fake parent session at a given lineage depth. */
function seedParent(db: any, depth = 0) {
  const id = 's_parent';
  db._sessions.set(id, {
    id,
    title: 'parent',
    status: 'active',
    profile_id: 'team',
    user_id: 'u1',
    channel: 'web',
    parent_session_id: null,
    metadata: JSON.stringify({ spawn_depth: depth }),
    created_at: '2026-06-18T00:00:00Z',
    updated_at: '2026-06-18T00:00:00Z',
  });
  return id;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ─── call_llm ────────────────────────────────────────────

describe('call_llm', () => {
  let db: any;
  beforeEach(() => {
    db = makeFakeDb();
  });

  it('returns the model output and records the full input/output to the audit log', async () => {
    const tool = createCallLlmTool(db, {
      userId: 'u1',
      sessionId: 's1',
      profileId: 'team',
      generate: async ({ prompt }) => ({ text: `SUMMARY of: ${prompt}`, usage: { inputTokens: 12, outputTokens: 4 } }),
    });

    const out: any = await tool.execute!({ prompt: 'a very long document' } as any, {} as any);

    expect(out.output).toBe('SUMMARY of: a very long document');
    expect(out.llm_call_id).toBeTruthy();
    expect(out.usage).toEqual({ input_tokens: 12, output_tokens: 4 });

    expect(db._llmCalls).toHaveLength(1);
    const rec = db._llmCalls[0];
    expect(rec.session_id).toBe('s1');
    expect(rec.input).toBe('a very long document');
    expect(rec.output).toBe('SUMMARY of: a very long document');
    expect(rec.status).toBe('ok');
    expect(db._budgetReservations).toHaveLength(1);
    expect(db._budgetSettlements).toEqual([
      expect.objectContaining({
        idempotency_key: db._budgetReservations[0].idempotency_key,
        actual_units: 16,
      }),
    ]);
    expect(db._usageRows).toEqual([
      expect.objectContaining({ budget_idempotency_key: db._budgetReservations[0].idempotency_key }),
    ]);
  });

  it('records an error row (and returns an error) when the call throws', async () => {
    const tool = createCallLlmTool(db, {
      userId: 'u1',
      sessionId: 's1',
      profileId: 'team',
      generate: async () => {
        throw new Error('boom');
      },
    });

    const out: any = await tool.execute!({ prompt: 'x' } as any, {} as any);
    expect(out.error).toContain('boom');
    expect(db._llmCalls).toHaveLength(1);
    expect(db._llmCalls[0].status).toBe('error');
    expect(db._llmCalls[0].error).toContain('boom');
    expect(db._budgetReservations).toHaveLength(1);
    expect(db._budgetSettlements).toHaveLength(0);
    expect(db._budgetReleases).toHaveLength(0);
  });

  it('forwards an abort signal to the model call (timeout / parent-cancel wiring)', async () => {
    let gotSignal: unknown;
    const tool = createCallLlmTool(db, {
      userId: 'u1',
      sessionId: 's1',
      profileId: 'team',
      generate: async ({ abortSignal }) => {
        gotSignal = abortSignal;
        return { text: 'ok' };
      },
    });
    await tool.execute!({ prompt: 'x' } as any, {} as any);
    expect(gotSignal).toBeInstanceOf(AbortSignal);
  });

  it('rejects an unknown model id without calling the model', async () => {
    let called = false;
    const tool = createCallLlmTool(db, {
      userId: 'u1',
      sessionId: 's1',
      profileId: 'team',
      generate: async () => {
        called = true;
        return { text: 'nope' };
      },
    });
    const out: any = await tool.execute!({ prompt: 'x', model: 'not-a-real-model' } as any, {} as any);
    expect(out.error).toMatch(/Unknown model/);
    expect(called).toBe(false);
    expect(db._llmCalls).toHaveLength(0);
    expect(db._budgetReservations).toHaveLength(0);
  });
});

// ─── spawn_session ───────────────────────────────────────

describe('spawn_session', () => {
  let db: any;
  let assembleCalls: Array<{ depth: number; childSessionId: string }>;

  const assembleChildTools = async ({ childSessionId, depth }: any) => {
    assembleCalls.push({ childSessionId, depth });
    return {}; // empty tool set is fine — the stubbed generate never uses tools
  };

  beforeEach(() => {
    db = makeFakeDb();
    assembleCalls = [];
  });

  function makeTool(generate: any) {
    const parentId = seedParent(db, 0);
    return createSpawnSessionTool(db, {
      userId: 'u1',
      userRole: 'team',
      parentSessionId: parentId,
      parentProfileId: 'team',
      assembleChildTools,
      generate,
    });
  }

  it('sync: creates a linked child session, runs it, and returns the result', async () => {
    const tool = makeTool(async () => ({
      text: 'child answer',
      usage: { inputTokens: 5, outputTokens: 9 },
      steps: [],
    }));

    const out: any = await tool.execute!({ prompt: 'do a subtask', mode: 'sync' } as any, {} as any);

    expect(out.status).toBe('completed');
    expect(out.depth).toBe(1);
    expect(out.result).toBe('child answer');

    const child = db._sessions.get(out.child_session_id);
    expect(child.parent_session_id).toBe('s_parent');
    expect(child.channel).toBe('subagent');
    expect(JSON.parse(child.metadata).spawn_depth).toBe(1);
    // #4: title is prefixed; output echoes it for the artifact card (#3)
    expect(child.title).toMatch(/^\[spawn-session\] /);
    expect(out.title).toBe(child.title);

    // child got the user prompt + the persisted assistant answer
    const childMsgs = db._messages.filter((m: any) => m.session_id === out.child_session_id);
    expect(childMsgs.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(childMsgs[1].content).toBe('child answer');

    // assembleChildTools was asked for depth 1
    expect(assembleCalls).toEqual([{ childSessionId: out.child_session_id, depth: 1 }]);
  });

  it('sync: a failed child is not left blank — persists a failure message and returns an error', async () => {
    const tool = makeTool(async () => {
      throw new Error('model exploded');
    });
    const out: any = await tool.execute!({ prompt: 'do x', mode: 'sync' } as any, {} as any);

    expect(out.status).toBe('error');
    expect(out.error).toContain('model exploded');
    const childMsgs = db._messages.filter((m: any) => m.session_id === out.child_session_id);
    // user prompt + a persisted assistant failure notice — never a blank child.
    expect(childMsgs.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(childMsgs[1].content).toMatch(/失败/);
  });

  it('sync: fails closed without appending a stale result when the child prompt is edited mid-run', async () => {
    const tool = makeTool(async () => {
      db._messages.at(-1).content = 'edited while running';
      return { text: 'answer based on old prompt', steps: [] };
    });

    const out: any = await tool.execute!({ prompt: 'do x', mode: 'sync' } as any, {} as any);

    expect(out.status).toBe('conflict');
    const childMsgs = db._messages.filter((message: any) => message.session_id === out.child_session_id);
    expect(childMsgs).toHaveLength(1);
    expect(childMsgs[0]).toMatchObject({ role: 'user', content: 'edited while running' });
  });

  it('async without confirm is rejected; no session is created', async () => {
    const tool = makeTool(async () => ({ text: 'x', steps: [] }));
    const out: any = await tool.execute!({ prompt: 'bg task', mode: 'async' } as any, {} as any);
    expect(out.error).toMatch(/confirm:true/);
    expect(db._sessions.has('s_1')).toBe(false);
  });

  it('async with confirm returns only after a durable enqueue and does not fire-and-forget', async () => {
    let generated = false;
    const tool = makeTool(async () => {
      generated = true;
      return { text: 'bg done', usage: {}, steps: [] };
    });
    const out: any = await tool.execute!({ prompt: 'bg task', mode: 'async', confirm: true } as any, {} as any);

    expect(out.status).toBe('started');
    const childId = out.child_session_id;
    expect(db._sessions.get(childId).channel).toBe('subagent');

    await flush();
    const childMsgs = db._messages.filter((m: any) => m.session_id === childId);
    expect(childMsgs).toEqual([expect.objectContaining({ role: 'user', content: 'bg task' })]);
    expect(generated).toBe(false);
    expect(db._runtimeRuns.get(out.runtime_run_id)).toMatchObject({
      kind: 'subagent',
      source_kind: 'spawned_session',
      source_id: childId,
      status: 'queued',
      max_attempts: 1,
    });
  });

  it('refuses to spawn beyond the depth cap', async () => {
    seedParent(db, MAX_SPAWN_DEPTH); // a parent already at the cap → child would exceed
    const tool = createSpawnSessionTool(db, {
      userId: 'u1',
      userRole: 'team',
      parentSessionId: 's_parent',
      parentProfileId: 'team',
      assembleChildTools,
      generate: async () => ({ text: 'should not run', steps: [] }),
    });
    const out: any = await tool.execute!({ prompt: 'too deep', mode: 'sync' } as any, {} as any);
    expect(out.error).toMatch(/depth/i);
    expect(assembleCalls).toHaveLength(0);
  });
});

// ─── recursion guard + registration invariants ───────────

describe('childSpawnToolIds (recursion guard)', () => {
  it('keeps only catalogued read-only tools in the first unattended rollout', () => {
    const ids = ['call_llm', 'spawn_session', 'session_query'];
    expect(childSpawnToolIds(ids, MAX_SPAWN_DEPTH - 1)).toEqual(['session_query']);
    expect(childSpawnToolIds(ids, MAX_SPAWN_DEPTH)).toEqual(['session_query']);
  });
});

describe('tool registration', () => {
  it('registers spawn_session and call_llm as lazy tools', () => {
    expect(getAllToolIds()).toEqual(expect.arrayContaining(['spawn_session', 'call_llm']));
    expect(LAZY_TOOL_IDS.has('spawn_session')).toBe(true);
    expect(LAZY_TOOL_IDS.has('call_llm')).toBe(true);
  });

  it('both tools are default-on (is_global) for internal users; spawn renders as an artifact', () => {
    expect(getToolMeta('spawn_session')?.is_global).toBe(true);
    expect(getToolMeta('call_llm')?.is_global).toBe(true);
    expect(getToolMeta('spawn_session')?.presentation).toBe('artifact');
  });
});
