import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeInterruptRow, RuntimeRunRow } from '@greenhouse/db';
import type { AppEnv } from '../app-env.js';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  featureAllowed: vi.fn(),
  missionController: { cancelRun: vi.fn() },
  workflowEngine: { pauseRun: vi.fn(), resumeRun: vi.fn(), cancelRun: vi.fn(), decideGate: vi.fn() },
  mirrorMissionRunById: vi.fn(),
  mirrorWorkflowRunById: vi.fn(),
  settleQueuedEvalCancellation: vi.fn(),
  delegateAutomationRuntimeCancel: vi.fn(),
  settleQueuedAutomationCancellation: vi.fn(),
  delegateSubagentRuntimeCancel: vi.fn(),
  settleQueuedSubagentCancellation: vi.fn(),
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
vi.mock('../cloud-agent/index.js', () => ({
  getMissionRuntimeStatus: () => ({ state: 'ready' }),
  getCloudAgentController: () => mocks.missionController,
}));
vi.mock('../auth/features.js', () => ({ userHasFeature: mocks.featureAllowed }));
vi.mock('../workflow-engine/index.js', () => ({ getWorkflowEngine: () => mocks.workflowEngine }));
vi.mock('../runtime/adapters.js', () => ({
  mirrorMissionRunById: mocks.mirrorMissionRunById,
  mirrorWorkflowRunById: mocks.mirrorWorkflowRunById,
}));
vi.mock('../runtime/eval-driver.js', () => ({
  settleQueuedEvalCancellation: mocks.settleQueuedEvalCancellation,
}));
vi.mock('../scheduler/runtime-driver.js', () => ({
  delegateAutomationRuntimeCancel: mocks.delegateAutomationRuntimeCancel,
  settleQueuedAutomationCancellation: mocks.settleQueuedAutomationCancellation,
}));
vi.mock('../runtime/subagent-driver.js', () => ({
  delegateSubagentRuntimeCancel: mocks.delegateSubagentRuntimeCancel,
  settleQueuedSubagentCancellation: mocks.settleQueuedSubagentCancellation,
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
    mocks.featureAllowed.mockResolvedValue(true);
    mocks.settleQueuedEvalCancellation.mockImplementation(async (_db, run) => run);
    mocks.settleQueuedAutomationCancellation.mockImplementation(async (_db, run) => run);
    mocks.settleQueuedSubagentCancellation.mockImplementation(async (_db, run) => run);
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
      kinds: ['mission', 'automation', 'subagent'],
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

  it('returns a full owner detail with orthogonal projection and source-limited capabilities', async () => {
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
    expect(body.capabilities).toEqual({ commands: ['cancel'], actions: ['cancel', 'approve', 'reject'] });
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
      kinds: ['mission', 'automation', 'subagent'],
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
      kinds: ['mission', 'automation', 'subagent'],
    });
    expect((await app.request('/summary?scope=all')).status).toBe(403);
  });

  it('fails closed across task lists, details, events, interrupts and summary when Mission is disabled', async () => {
    mocks.featureAllowed.mockResolvedValue(false);
    const run = runRow();
    const interrupt = interruptRow();
    const runtime = {
      getRun: vi.fn().mockResolvedValue(run),
      getRunDetail: vi.fn(),
      listEvents: vi.fn(),
      listRuns: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
      listInterruptsPage: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
      summarize: vi.fn().mockResolvedValue({ runs: { total: 0, by_status: {}, by_kind: {} }, pending_interrupts: 0 }),
      getInterrupt: vi.fn().mockResolvedValue(interrupt),
      executeRunDomainCommand: vi.fn(),
    };
    mocks.getDb.mockReturnValue({ runtime });
    const app = appFor({ id: 'owner', role: 'team' });

    expect((await app.request('/runs')).status).toBe(200);
    expect((await app.request('/interrupts')).status).toBe(200);
    expect((await app.request('/summary')).status).toBe(200);
    expect(runtime.listRuns).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['automation', 'subagent'] }));
    expect(runtime.listInterruptsPage).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: ['automation', 'subagent'] }),
    );
    expect(runtime.summarize).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['automation', 'subagent'] }));

    expect((await app.request(`/runs/${run.id}`)).status).toBe(404);
    expect((await app.request(`/runs/${run.id}/events`)).status).toBe(404);
    expect(
      (
        await app.request(`/runs/${run.id}/commands`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'cancel', expected_version: run.version, idempotency_key: 'denied-run' }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/interrupts/${interrupt.id}/commands`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'approve',
            expected_version: interrupt.version,
            idempotency_key: 'denied-interrupt',
          }),
        })
      ).status,
    ).toBe(404);
    expect(runtime.getRunDetail).not.toHaveBeenCalled();
    expect(runtime.listEvents).not.toHaveBeenCalled();
    expect(runtime.executeRunDomainCommand).not.toHaveBeenCalled();
  });

  it('keeps Workflow source rows super-only even when a team user owns the projection', async () => {
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

  it('re-checks source authorization while the persistent command fence is held', async () => {
    const run = runRow();
    mocks.featureAllowed.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const runtime = {
      getRun: vi.fn().mockResolvedValue(run),
      executeRunDomainCommand: vi.fn(
        async (
          _command: unknown,
          _actor: unknown,
          effect: (context: { run: RuntimeRunRow; may_drive: boolean }) => Promise<void>,
        ) => {
          await effect({ run, may_drive: true });
          return { run, idempotent: false };
        },
      ),
    };
    mocks.getDb.mockReturnValue({ runtime, agentRuns: { getRunById: vi.fn() } });

    const response = await appFor({ id: 'owner', role: 'team' }).request(`/runs/${run.id}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'cancel', expected_version: run.version, idempotency_key: 'revoked-command' }),
    });

    expect(response.status).toBe(404);
    expect(mocks.missionController.cancelRun).not.toHaveBeenCalled();
    expect(mocks.mirrorMissionRunById).not.toHaveBeenCalled();
  });

  it('treats a domain-settled Mission command as a crash-window retry without mutating the read model', async () => {
    const stale = runRow({ version: 3 });
    const mirrored = runRow({ status: 'canceled', desired_state: 'cancel', version: 4 });
    const runtime = {
      getRun: vi.fn().mockResolvedValue(stale),
      executeRunDomainCommand: vi.fn(
        async (
          _command: unknown,
          _actor: unknown,
          effect: (context: { run: RuntimeRunRow; may_drive: boolean }) => Promise<void>,
        ) => {
          await effect({ run: stale, may_drive: false });
          return { run: stale, idempotent: false };
        },
      ),
    };
    const agentRuns = { getRunById: vi.fn().mockResolvedValue({ id: 'car_1', status: 'canceled' }) };
    mocks.getDb.mockReturnValue({ runtime, agentRuns });
    mocks.mirrorMissionRunById.mockResolvedValue(mirrored);

    const response = await appFor({ id: 'owner', role: 'team' }).request(`/runs/${stale.id}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'cancel', expected_version: 2, idempotency_key: 'cancel-after-crash' }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toMatchObject({ run: { status: 'canceled', version: 4 } });
    expect(mocks.missionController.cancelRun).not.toHaveBeenCalled();
    expect(runtime.executeRunDomainCommand).toHaveBeenCalledWith(
      expect.objectContaining({ idempotency_key: 'cancel-after-crash' }),
      'owner',
      expect.any(Function),
    );
  });

  it('durably cancels a queued Eval source and immediately terminalizes its Runtime envelope', async () => {
    const queued = runRow({
      id: 'runtime-eval-1',
      root_run_id: 'runtime-eval-1',
      kind: 'eval',
      source_kind: 'eval_run',
      source_id: 'eval-run-1',
      status: 'queued',
      version: 1,
    });
    const commanded = runRow({ ...queued, desired_state: 'cancel', version: 2 });
    const canceled = runRow({ ...commanded, status: 'canceled', version: 3 });
    const cancelRun = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      getRun: vi.fn().mockResolvedValue(queued),
      executeRunDomainCommand: vi.fn(
        async (
          _command: unknown,
          _actor: unknown,
          effect: (context: { run: RuntimeRunRow; may_drive: boolean }) => Promise<void>,
        ) => {
          await effect({ run: queued, may_drive: true });
          return { run: commanded, idempotent: false };
        },
      ),
    };
    const evalService = { getRun: vi.fn().mockResolvedValue({ id: 'eval-run-1', status: 'queued' }), cancelRun };
    mocks.getDb.mockReturnValue({ runtime, eval: evalService });
    mocks.settleQueuedEvalCancellation.mockResolvedValueOnce(canceled);

    const response = await appFor({ id: 'admin', role: 'super' }).request(`/runs/${queued.id}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'cancel', expected_version: 1, idempotency_key: 'cancel-queued-eval' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ run: { status: 'canceled', desired_state: 'cancel', version: 3 } });
    expect(cancelRun).toHaveBeenCalledWith('eval-run-1');
    expect(mocks.settleQueuedEvalCancellation).toHaveBeenCalledWith(
      expect.objectContaining({ runtime }),
      commanded,
      'admin',
    );
  });

  it('records an already-decided approval after deferred mirror without commanding the interrupt read model', async () => {
    const run = runRow({ version: 4 });
    const pending = interruptRow({
      version: 2,
      payload: JSON.stringify({ source: 'mission_approval', approval_id: 'caa_1' }),
    });
    const resolved = interruptRow({
      version: 3,
      status: 'resolved',
      payload: pending.payload,
      decision: JSON.stringify({ source_status: 'approved' }),
    });
    const runtime = {
      getInterrupt: vi.fn().mockResolvedValueOnce(pending).mockResolvedValue(resolved),
      getRun: vi.fn().mockResolvedValue(run),
      getEventByIdempotency: vi.fn().mockResolvedValue(undefined),
      appendEvent: vi.fn().mockResolvedValue({}),
      commandInterrupt: vi.fn(),
    };
    const agentRuns = {
      getRunById: vi.fn().mockResolvedValue({ id: 'car_1', user_id: 'owner' }),
      getApprovalById: vi
        .fn()
        .mockResolvedValue({ id: 'caa_1', run_id: 'car_1', user_id: 'owner', status: 'approved' }),
      decideApproval: vi.fn(),
    };
    mocks.getDb.mockReturnValue({ runtime, agentRuns });
    mocks.mirrorMissionRunById.mockResolvedValue(run);

    const response = await appFor({ id: 'owner', role: 'team' }).request(`/interrupts/${pending.id}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'approve', expected_version: 1, idempotency_key: 'approve-after-crash' }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toMatchObject({ interrupt: { status: 'resolved', version: 3 } });
    expect(agentRuns.decideApproval).not.toHaveBeenCalled();
    expect(runtime.commandInterrupt).not.toHaveBeenCalled();
    expect(runtime.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        run_id: run.id,
        type: 'interrupt.domain_commanded',
        idempotency_key: 'approve-after-crash',
      }),
    );
  });
});
