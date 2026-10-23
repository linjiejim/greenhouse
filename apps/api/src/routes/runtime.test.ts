import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeInterruptRow, RuntimeRunRow } from '@greenhouse/db';
import type { AppEnv } from '../app-env.js';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  delegateAutomationRuntimeCancel: vi.fn(),
  settleQueuedAutomationCancellation: vi.fn(),
}));

vi.mock('@greenhouse/db', () => {
  class RuntimeKernelError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return { getDb: mocks.getDb, RuntimeKernelError };
});
vi.mock('../scheduler/runtime-driver.js', () => ({
  delegateAutomationRuntimeCancel: mocks.delegateAutomationRuntimeCancel,
  settleQueuedAutomationCancellation: mocks.settleQueuedAutomationCancellation,
}));

import runtimeRoutes from './runtime.js';

function runRow(overrides: Partial<RuntimeRunRow> = {}): RuntimeRunRow {
  return {
    id: 'rtm_car_1',
    kind: 'mission',
    owner_user_id: 'owner',
    initiated_by_user_id: 'owner',
    session_id: null,
    parent_run_id: null,
    root_run_id: 'rtm_car_1',
    source_kind: 'agent_run',
    source_id: 'car_1',
    idempotency_key: 'mission:car_1',
    status: 'running',
    desired_state: 'run',
    wait_reason: null,
    priority: 0,
    not_before: null,
    deadline_at: null,
    lease_owner: null,
    lease_expires_at: null,
    heartbeat_at: null,
    attempt: 0,
    max_attempts: 1,
    input: JSON.stringify({ prompt: 'keep exact', nested: { value: 1 } }),
    output: null,
    error_code: null,
    error_message: null,
    started_at: null,
    ended_at: null,
    settled_at: null,
    created_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
    version: 3,
    ...overrides,
  };
}

function interruptRow(overrides: Partial<RuntimeInterruptRow> = {}): RuntimeInterruptRow {
  return {
    id: 'rtmi_1',
    run_id: 'rtm_car_1',
    step_id: null,
    tool_call_id: null,
    kind: 'mutation_approval',
    status: 'pending',
    payload: JSON.stringify({ source: 'mission_approval', input: { exact: true } }),
    canonical_input_hash: 'hash',
    risk_level: 'r1',
    assignee_user_id: 'owner',
    expires_at: null,
    decision: null,
    decided_by_user_id: null,
    decided_at: null,
    created_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

function appFor(user: { id: string; role: 'team' | 'super' }) {
  return new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('user', user);
      await next();
    })
    .route('/', runtimeRoutes);
}

describe('Runtime API authorization and wire', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settleQueuedAutomationCancellation.mockImplementation(async (_db, run) => run);
  });

  it('lists only the caller task kinds by default and decodes complete JSON payloads', async () => {
    const runtime = {
      listRuns: vi.fn().mockResolvedValue({
        items: [runRow()],
        next_cursor: { created_at: '2026-08-12T00:00:00.000Z', id: 'rtm_car_1' },
      }),
    };
    mocks.getDb.mockReturnValue({ runtime });

    const response = await appFor({ id: 'owner', role: 'team' }).request('/runs?limit=25');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { runs: Array<{ input: unknown }>; next_cursor: string };
    expect(body.runs[0]!.input).toEqual({ prompt: 'keep exact', nested: { value: 1 } });
    expect(body.next_cursor).toEqual(expect.any(String));
    expect(runtime.listRuns).toHaveBeenCalledWith({
      owner_user_id: 'owner',
      kinds: ['mission', 'automation', 'subagent', 'agent_write'],
      cursor: undefined,
      limit: 25,
    });
  });

  it('rejects organization, Chat and Eval views for team users', async () => {
    const runtime = { listRuns: vi.fn() };
    mocks.getDb.mockReturnValue({ runtime });
    const app = appFor({ id: 'owner', role: 'team' });

    expect((await app.request('/runs?scope=all')).status).toBe(403);
    expect((await app.request('/runs?kinds=chat')).status).toBe(403);
    expect((await app.request('/runs?kinds=eval')).status).toBe(403);
    expect(runtime.listRuns).not.toHaveBeenCalled();
  });

  it('allows super organization pagination including Eval without adding an owner filter', async () => {
    const runtime = { listRuns: vi.fn().mockResolvedValue({ items: [], next_cursor: null }) };
    mocks.getDb.mockReturnValue({ runtime });
    const response = await appFor({ id: 'admin', role: 'super' }).request('/runs?scope=all&kinds=eval');
    expect(response.status).toBe(200);
    expect(runtime.listRuns).toHaveBeenCalledWith({ kinds: ['eval'], cursor: undefined, limit: 50 });
  });

  it('keeps a historical Mission run readable by its owner with no commands (Missions retired in v1.4)', async () => {
    const run = runRow();
    const interrupt = interruptRow();
    const runtime = {
      getRun: vi.fn().mockResolvedValue(run),
      getRunDetail: vi.fn().mockResolvedValue({
        run,
        events: [
          {
            id: 'rte_1',
            run_id: run.id,
            step_id: null,
            seq: 1,
            type: 'run.created',
            payload: JSON.stringify({ long: 'x'.repeat(10_000) }),
            actor_user_id: 'owner',
            idempotency_key: 'created',
            created_at: run.created_at,
          },
        ],
        steps: [],
        tool_calls: [],
        artifacts: [],
        interrupts: [interrupt],
      }),
    };
    mocks.getDb.mockReturnValue({ runtime });

    const response = await appFor({ id: 'owner', role: 'team' }).request(`/runs/${run.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      events: Array<{ payload: { long: string } }>;
      projection: { lifecycle: string; attention: string; transport: string };
      capabilities: { commands: string[]; actions: string[] };
    };
    expect(body.events[0]!.payload.long).toHaveLength(10_000);
    expect(body.projection).toEqual({ lifecycle: 'running', attention: 'approval', transport: 'live' });
    expect(body.capabilities).toEqual({ commands: [], actions: [] });
  });

  it('hides another owner run and every Eval run from a team user', async () => {
    const runtime = {
      getRun: vi
        .fn()
        .mockResolvedValueOnce(runRow({ owner_user_id: 'other' }))
        .mockResolvedValueOnce(runRow({ kind: 'eval' })),
    };
    mocks.getDb.mockReturnValue({ runtime });
    const app = appFor({ id: 'owner', role: 'team' });
    expect((await app.request('/runs/foreign')).status).toBe(404);
    expect((await app.request('/runs/eval')).status).toBe(404);
  });

  it('scopes the approval inbox to the assignee and decodes exact interrupt payloads', async () => {
    const interrupt = interruptRow();
    const runtime = {
      listInterruptsPage: vi.fn().mockResolvedValue({
        items: [{ interrupt, run: runRow() }],
        next_cursor: null,
      }),
    };
    mocks.getDb.mockReturnValue({ runtime });
    const response = await appFor({ id: 'owner', role: 'team' }).request('/interrupts');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ interrupt: { payload: unknown } }> };
    expect(body.items[0]!.interrupt.payload).toEqual({ source: 'mission_approval', input: { exact: true } });
    expect(runtime.listInterruptsPage).toHaveBeenCalledWith({
      assignee_user_id: 'owner',
      status: 'pending',
      kinds: ['mission', 'automation', 'subagent', 'agent_write'],
      cursor: undefined,
      limit: 50,
    });
  });

  it('returns owner summary counts and forbids organization summary to team users', async () => {
    const result = {
      runs: { total: 2, by_status: { running: 2 }, by_kind: { mission: 2 } },
      pending_interrupts: 1,
    };
    const runtime = { summarize: vi.fn().mockResolvedValue(result) };
    mocks.getDb.mockReturnValue({ runtime });
    const app = appFor({ id: 'owner', role: 'team' });
    expect(await (await app.request('/summary')).json()).toEqual(result);
    expect(runtime.summarize).toHaveBeenCalledWith({
      owner_user_id: 'owner',
      assignee_user_id: 'owner',
      kinds: ['mission', 'automation', 'subagent', 'agent_write'],
    });
    expect((await app.request('/summary?scope=all')).status).toBe(403);
  });

  it('keeps historical Workflow source rows super-only even when a team user owns the projection', async () => {
    const workflow = runRow({
      id: 'rtw_workflow_1',
      kind: 'workflow',
      root_run_id: 'rtw_workflow_1',
      source_kind: 'workflow_run',
      source_id: 'workflow_1',
    });
    const runtime = { getRun: vi.fn().mockResolvedValue(workflow), getRunDetail: vi.fn() };
    mocks.getDb.mockReturnValue({ runtime });

    expect((await appFor({ id: 'owner', role: 'team' }).request(`/runs/${workflow.id}`)).status).toBe(404);
    expect(runtime.getRunDetail).not.toHaveBeenCalled();
  });
});
