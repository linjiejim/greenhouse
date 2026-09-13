/**
 * Runtime 统一执行读模型 — /api/runtime
 *
 * GET  /runs                              — 自己的任务；super 可 scope=all
 * GET  /runs/:id                          — 完整 run/step/tool/artifact/interrupt 详情
 * GET  /runs/:id/events                   — 永久事件的游标回放
 * POST /runs/:id/commands                 — 委派领域 driver 支持的 run 命令
 * GET  /interrupts                        — 待我处理；super 可 scope=all
 * POST /interrupts/:id/commands           — 委派 Mission approval / Workflow gate 决策
 * GET  /summary                           — 执行中心与导航 badge 聚合
 */

import { Buffer } from 'node:buffer';
import { Hono, type Context } from 'hono';
import { getDb, RuntimeKernelError, type RuntimeEventRow, type RuntimeRunRow } from '@greenhouse/db';
import {
  availableRuntimeUserActions,
  projectRuntimeForUser,
  RUNTIME_INTERRUPT_STATUSES,
  RUNTIME_RUN_COMMAND_TYPES,
  RUNTIME_RUN_KINDS,
  type RuntimeInterruptStatus,
  type RuntimeJsonValue,
  type RuntimeRunCommand,
  type RuntimeRunCommandType,
  type RuntimeRunKind,
  type RuntimeUserAction,
} from '@greenhouse/types/runtime';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { AppEnv } from '../app-env.js';
import { userHasFeature } from '../auth/features.js';
import { getAuthUser, type AuthUser } from '../auth/middleware.js';
import { getMissionRuntimeStatus, getCloudAgentController } from '../cloud-agent/index.js';
import { getWorkflowEngine } from '../workflow-engine/index.js';
import { mirrorMissionRunById, mirrorWorkflowRunById } from '../runtime/adapters.js';
import { delegateAutomationRuntimeCancel, settleQueuedAutomationCancellation } from '../scheduler/runtime-driver.js';
import { delegateSubagentRuntimeCancel, settleQueuedSubagentCancellation } from '../runtime/subagent-driver.js';
import { settleQueuedEvalCancellation } from '../runtime/eval-driver.js';
import {
  requireTrustedExecutionSurface,
  resolveTrustedExecutionSwitches,
  runtimeAdapterEnabled,
  trustedExecutionBootPlan,
} from '../trusted-execution/kill-switches.js';
import {
  runtimeArtifactView as artifactView,
  runtimeEventView as eventView,
  runtimeInterruptView as interruptView,
  runtimePayloadView as parsePayload,
  runtimeRunView as runView,
  runtimeStepView as stepView,
  runtimeToolCallView as toolCallView,
} from '../runtime/views.js';

const DEFAULT_TASK_KINDS = [
  'mission',
  'workflow',
  'automation',
  'subagent',
] as const satisfies readonly RuntimeRunKind[];
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,256}$/;

function approvalInboxEnabled(): boolean {
  return trustedExecutionBootPlan(resolveTrustedExecutionSwitches()).approvalInbox;
}

type Cursor = { created_at: string; id: string };

function encodeCursor(cursor: Cursor | null): string | null {
  return cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null;
}

function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      typeof decoded.created_at !== 'string' ||
      !Number.isFinite(Date.parse(decoded.created_at)) ||
      typeof decoded.id !== 'string' ||
      decoded.id.length === 0 ||
      decoded.id.length > 512
    ) {
      throw new Error('invalid cursor fields');
    }
    return { created_at: decoded.created_at, id: decoded.id };
  } catch {
    throw new Error('cursor is malformed');
  }
}

function supportedActions(run: RuntimeRunRow): RuntimeUserAction[] {
  if (run.source_kind === 'agent_run') return ['cancel', 'approve', 'reject'];
  if (run.source_kind === 'workflow_run') return ['pause', 'resume', 'cancel', 'approve', 'reject'];
  if (run.source_kind === 'eval_run') return ['cancel'];
  if (run.kind === 'automation' && run.source_kind.startsWith('scheduled_task:')) return ['cancel'];
  if (run.kind === 'subagent' && run.source_kind === 'spawned_session') return ['cancel'];
  return [];
}

function requestedKinds(raw: string | undefined, isSuper: boolean): RuntimeRunKind[] {
  if (!raw) return [...DEFAULT_TASK_KINDS];
  const values = [
    ...new Set(
      raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (values.length === 0 || values.some((value) => !(RUNTIME_RUN_KINDS as readonly string[]).includes(value))) {
    throw new Error('kinds contains an unknown Runtime kind');
  }
  if (!isSuper && values.some((value) => !(DEFAULT_TASK_KINDS as readonly string[]).includes(value))) {
    throw new Error('Chat and Eval Runtime views are available to super only');
  }
  return values as RuntimeRunKind[];
}

/** Runtime is a read model, not an authorization grant. */
async function authorizedKinds(user: AuthUser, raw: string | undefined): Promise<RuntimeRunKind[]> {
  const requested = requestedKinds(raw, user.role === 'super');
  if (user.role === 'super') return requested;
  const missionAllowed = requested.includes('mission')
    ? await userHasFeature(user.id, user.role, 'cloud-agent')
    : false;
  return requested.filter((kind) => {
    if (kind === 'mission') return missionAllowed;
    if (kind === 'workflow' || kind === 'chat' || kind === 'eval') return false;
    return true;
  });
}

async function canAccessRunSource(user: AuthUser, run: RuntimeRunRow): Promise<boolean> {
  if (user.role === 'super') return true;
  if (run.kind === 'workflow' || run.source_kind === 'workflow_run' || run.kind === 'chat' || run.kind === 'eval') {
    return false;
  }
  if (run.kind === 'mission' || run.source_kind === 'agent_run') {
    // Official adapters always emit this exact pair. A malformed cross-kind
    // projection is denied instead of inheriting the more permissive kind.
    if (run.kind !== 'mission' || run.source_kind !== 'agent_run') return false;
    return userHasFeature(user.id, user.role, 'cloud-agent');
  }
  if (run.kind === 'automation') return run.source_kind.startsWith('scheduled_task:');
  if (run.kind === 'subagent') return run.source_kind === 'spawned_session';
  return false;
}

function requestedScope(raw: string | undefined, isSuper: boolean): 'own' | 'all' {
  const scope = raw ?? 'own';
  if (scope !== 'own' && scope !== 'all') throw new Error("scope must be 'own' or 'all'");
  if (scope === 'all' && !isSuper) throw new Error('Organization Runtime scope requires super');
  return scope;
}

function requestedLimit(raw: string | undefined): number {
  if (raw === undefined) return 50;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('limit must be an integer from 1 to 100');
  return limit;
}

function runtimeError(c: Context<AppEnv>, error: unknown) {
  if (error instanceof RuntimeKernelError) {
    const status =
      error.code === 'runtime_not_found'
        ? 404
        : error.code === 'runtime_version_conflict' ||
            error.code === 'runtime_invalid_transition' ||
            error.code === 'runtime_idempotency_conflict'
          ? 409
          : 400;
    return c.json({ error: error.message, code: error.code }, status);
  }
  if (/Mission runtime is unavailable/.test(toErrorMessage(error))) {
    return c.json({ error: 'Mission runtime is unavailable', code: 'mission_runtime_unavailable' }, 503);
  }
  if (/Runtime (Mission|Workflow) adapter is disabled/.test(toErrorMessage(error))) {
    return c.json({ error: toErrorMessage(error), code: 'runtime_adapter_disabled' }, 503);
  }
  return c.json({ error: toErrorMessage(error) }, 400);
}

function assertSourceAdapterEnabled(run: RuntimeRunRow): void {
  if (run.source_kind === 'agent_run' && !runtimeAdapterEnabled('mission')) {
    throw new Error('Runtime Mission adapter is disabled');
  }
  if (run.source_kind === 'workflow_run' && !runtimeAdapterEnabled('workflow')) {
    throw new Error('Runtime Workflow adapter is disabled');
  }
}

async function ownedRun(c: Context<AppEnv>, id: string) {
  const user = getAuthUser(c);
  const run = await getDb().runtime.getRun(id);
  if (!run || (run.owner_user_id !== user.id && user.role !== 'super') || !(await canAccessRunSource(user, run))) {
    return null;
  }
  return run;
}

function sameCommand(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertCommandReplay(
  event: RuntimeEventRow,
  eventType: 'run.domain_commanded' | 'interrupt.domain_commanded',
  command: RuntimeJsonValue,
): void {
  const payload = parsePayload(event.payload);
  if (
    event.type !== eventType ||
    !payload ||
    Array.isArray(payload) ||
    typeof payload !== 'object' ||
    !sameCommand(payload.command, command)
  ) {
    throw new RuntimeKernelError(
      'runtime_idempotency_conflict',
      'Runtime command idempotency key was reused with different input',
    );
  }
}

async function recordDomainCommand(input: {
  run: RuntimeRunRow;
  type: 'run.domain_commanded' | 'interrupt.domain_commanded';
  command: RuntimeJsonValue;
  idempotencyKey: string;
  actorUserId: string;
  result: RuntimeJsonValue;
}): Promise<void> {
  await getDb().runtime.appendEvent({
    run_id: input.run.id,
    type: input.type,
    payload: { command: input.command, result: input.result },
    actor_user_id: input.actorUserId,
    idempotency_key: input.idempotencyKey,
  });
}

async function delegateRunCommand(run: RuntimeRunRow, type: RuntimeRunCommandType, mayDrive: boolean): Promise<void> {
  if (run.source_kind === 'agent_run') {
    if (type !== 'cancel')
      throw new RuntimeKernelError('runtime_invalid_transition', `Mission does not support ${type}`);
    const source = await getDb().agentRuns.getRunById(run.source_id);
    if (!source) throw new RuntimeKernelError('runtime_not_found', 'Mission source run is missing');
    if (source.status === 'canceled') return;
    if (!mayDrive) {
      throw new RuntimeKernelError('runtime_version_conflict', `Runtime run ${run.id} changed concurrently`);
    }
    if (source.status === 'completed' || source.status === 'failed') {
      throw new RuntimeKernelError('runtime_invalid_transition', `Mission is already ${source.status}`);
    }
    const controller = getCloudAgentController();
    if (!controller || getMissionRuntimeStatus().state !== 'ready') {
      throw new Error('Mission runtime is unavailable');
    }
    const result = await controller.cancelRun(run.source_id);
    if (!result) throw new RuntimeKernelError('runtime_invalid_transition', 'Mission can no longer be canceled');
    return;
  }
  if (run.source_kind === 'workflow_run') {
    const source = await getDb().workflows.getRun(run.source_id);
    if (!source) throw new RuntimeKernelError('runtime_not_found', 'Workflow source run is missing');
    const target = type === 'pause' ? 'paused' : type === 'resume' ? 'running' : type === 'cancel' ? 'canceled' : null;
    if (!target) throw new RuntimeKernelError('runtime_invalid_transition', `Workflow does not support ${type}`);
    if (source.status === target) return;
    if (!mayDrive) {
      throw new RuntimeKernelError('runtime_version_conflict', `Runtime run ${run.id} changed concurrently`);
    }
    const engine = getWorkflowEngine();
    if (type === 'pause') await engine.pauseRun(run.source_id);
    else if (type === 'resume') await engine.resumeRun(run.source_id);
    else if (type === 'cancel') await engine.cancelRun(run.source_id);
    return;
  }
  if (run.source_kind === 'eval_run') {
    if (type !== 'cancel') throw new RuntimeKernelError('runtime_invalid_transition', `Eval does not support ${type}`);
    const source = await getDb().eval.getRun(run.source_id);
    if (!source) throw new RuntimeKernelError('runtime_not_found', 'Eval source run is missing');
    if (source.status === 'cancelled') return;
    if (!mayDrive) {
      throw new RuntimeKernelError('runtime_version_conflict', `Runtime run ${run.id} changed concurrently`);
    }
    if (source.status !== 'queued' && source.status !== 'running') {
      throw new RuntimeKernelError('runtime_invalid_transition', `Eval is already ${source.status}`);
    }
    await getDb().eval.cancelRun(run.source_id);
    return;
  }
  if (run.kind === 'automation' && run.source_kind.startsWith('scheduled_task:')) {
    await delegateAutomationRuntimeCancel(getDb(), run, type, mayDrive);
    return;
  }
  if (run.kind === 'subagent' && run.source_kind === 'spawned_session') {
    await delegateSubagentRuntimeCancel(getDb(), run, type, mayDrive);
    return;
  }
  throw new RuntimeKernelError('runtime_invalid_transition', `Runtime source ${run.source_kind} has no command driver`);
}

export const runtimeRoutes = new Hono<AppEnv>()
  .use('/interrupts', requireTrustedExecutionSurface(approvalInboxEnabled, 'approval-inbox'))
  .use('/interrupts/*', requireTrustedExecutionSurface(approvalInboxEnabled, 'approval-inbox'))
  .get('/runs', async (c) => {
    const user = getAuthUser(c);
    try {
      const scope = requestedScope(c.req.query('scope'), user.role === 'super');
      const kinds = await authorizedKinds(user, c.req.query('kinds'));
      const result = await getDb().runtime.listRuns({
        ...(scope === 'own' ? { owner_user_id: user.id } : {}),
        kinds,
        cursor: decodeCursor(c.req.query('cursor')),
        limit: requestedLimit(c.req.query('limit')),
      });
      return c.json({ runs: result.items.map(runView), next_cursor: encodeCursor(result.next_cursor) });
    } catch (error) {
      const message = toErrorMessage(error);
      return c.json({ error: message }, /requires super|available to super/.test(message) ? 403 : 400);
    }
  })
  .get('/runs/:id', async (c) => {
    const run = await ownedRun(c, c.req.param('id'));
    if (!run) return c.json({ error: 'Run not found' }, 404);
    const detail = await getDb().runtime.getRunDetail(run.id);
    if (!detail) return c.json({ error: 'Run not found' }, 404);
    const interrupts = detail.interrupts.map(interruptView);
    const approvalInboxAvailable = approvalInboxEnabled();
    const surfaceActions = supportedActions(run).filter(
      (action) => approvalInboxAvailable || (action !== 'approve' && action !== 'reject'),
    );
    const actions = availableRuntimeUserActions({
      status: run.status,
      desired_state: run.desired_state,
      interrupts,
      supported_actions: surfaceActions,
    });
    return c.json({
      run: runView(detail.run),
      events: detail.events.map(eventView),
      steps: detail.steps.map(stepView),
      tool_calls: detail.tool_calls.map(toolCallView),
      artifacts: detail.artifacts.map(artifactView),
      interrupts,
      projection: projectRuntimeForUser({ status: run.status, interrupts }),
      capabilities: {
        commands: actions.filter((action): action is RuntimeRunCommandType =>
          (RUNTIME_RUN_COMMAND_TYPES as readonly RuntimeUserAction[]).includes(action),
        ),
        actions,
      },
    });
  })
  .get('/runs/:id/events', async (c) => {
    const run = await ownedRun(c, c.req.param('id'));
    if (!run) return c.json({ error: 'Run not found' }, 404);
    const after = Number(c.req.query('after') ?? 0);
    const limit = requestedLimit(c.req.query('limit'));
    if (!Number.isSafeInteger(after) || after < 0)
      return c.json({ error: 'after must be a non-negative integer' }, 400);
    const events = await getDb().runtime.listEvents(run.id, { after, limit });
    return c.json({ events: events.map(eventView), next_after: events.at(-1)?.seq ?? after });
  })
  .post('/runs/:id/commands', async (c) => {
    const user = getAuthUser(c);
    const run = await ownedRun(c, c.req.param('id'));
    if (!run) return c.json({ error: 'Run not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      type?: unknown;
      expected_version?: unknown;
      idempotency_key?: unknown;
    };
    if (typeof body.type !== 'string' || !(RUNTIME_RUN_COMMAND_TYPES as readonly string[]).includes(body.type)) {
      return c.json({ error: 'type is not a Runtime run command' }, 400);
    }
    if (!Number.isSafeInteger(body.expected_version) || Number(body.expected_version) < 1) {
      return c.json({ error: 'expected_version must be a positive integer' }, 400);
    }
    if (typeof body.idempotency_key !== 'string' || !IDEMPOTENCY_KEY_RE.test(body.idempotency_key)) {
      return c.json({ error: 'idempotency_key is malformed' }, 400);
    }
    const command: RuntimeRunCommand = {
      type: body.type as RuntimeRunCommandType,
      run_id: run.id,
      expected_version: Number(body.expected_version),
      idempotency_key: body.idempotency_key,
    };
    try {
      assertSourceAdapterEnabled(run);
      // Re-check after parsing, including the idempotent-replay path where the
      // fenced callback is intentionally not re-run.
      if (!(await canAccessRunSource(user, run))) {
        throw new RuntimeKernelError('runtime_not_found', 'Runtime run is not available');
      }
      const fenced = await getDb().runtime.executeRunDomainCommand(
        command,
        user.id,
        async ({ run: locked, may_drive: mayDrive }) => {
          // The source-domain authorization is deliberately re-evaluated while
          // the persistent Runtime command fence is held. Runtime ownership is
          // only a read-model fact and must never preserve revoked authority.
          if (!(await canAccessRunSource(user, locked))) {
            throw new RuntimeKernelError('runtime_not_found', 'Runtime run is not available');
          }
          await delegateRunCommand(locked, command.type, mayDrive);
        },
      );
      let commandedRun = fenced.run;
      if (command.type === 'cancel' && commandedRun.kind === 'eval') {
        commandedRun = await settleQueuedEvalCancellation(getDb(), commandedRun, user.id);
      } else if (command.type === 'cancel' && commandedRun.kind === 'automation') {
        commandedRun = await settleQueuedAutomationCancellation(getDb(), commandedRun, user.id);
      } else if (command.type === 'cancel' && commandedRun.kind === 'subagent') {
        commandedRun = await settleQueuedSubagentCancellation(getDb(), commandedRun, user.id);
      }
      const mirrored =
        commandedRun.source_kind === 'agent_run'
          ? await mirrorMissionRunById(getDb(), commandedRun.source_id)
          : commandedRun.source_kind === 'workflow_run'
            ? await mirrorWorkflowRunById(getDb(), commandedRun.source_id)
            : commandedRun.source_kind === 'eval_run'
              ? commandedRun
              : commandedRun;
      if (!mirrored) throw new RuntimeKernelError('runtime_not_found', 'Runtime domain source is missing');
      return c.json({ run: runView(mirrored), ...(fenced.idempotent ? { idempotent: true } : {}) });
    } catch (error) {
      return runtimeError(c, error);
    }
  })
  .get('/interrupts', async (c) => {
    const user = getAuthUser(c);
    try {
      const scope = requestedScope(c.req.query('scope'), user.role === 'super');
      const kinds = await authorizedKinds(user, c.req.query('kinds'));
      const statusRaw = c.req.query('status') ?? 'pending';
      if (!(RUNTIME_INTERRUPT_STATUSES as readonly string[]).includes(statusRaw)) {
        return c.json({ error: 'status is not a Runtime interrupt status' }, 400);
      }
      const result = await getDb().runtime.listInterruptsPage({
        ...(scope === 'own' ? { assignee_user_id: user.id } : {}),
        status: statusRaw as RuntimeInterruptStatus,
        kinds,
        cursor: decodeCursor(c.req.query('cursor')),
        limit: requestedLimit(c.req.query('limit')),
      });
      return c.json({
        items: result.items.map((item) => ({ interrupt: interruptView(item.interrupt), run: runView(item.run) })),
        next_cursor: encodeCursor(result.next_cursor),
      });
    } catch (error) {
      const message = toErrorMessage(error);
      return c.json({ error: message }, /requires super|available to super/.test(message) ? 403 : 400);
    }
  })
  .post('/interrupts/:id/commands', async (c) => {
    const user = getAuthUser(c);
    const interrupt = await getDb().runtime.getInterrupt(c.req.param('id'));
    if (!interrupt) return c.json({ error: 'Interrupt not found' }, 404);
    const run = await getDb().runtime.getRun(interrupt.run_id);
    if (
      !run ||
      (interrupt.assignee_user_id !== user.id && user.role !== 'super') ||
      !(await canAccessRunSource(user, run))
    ) {
      return c.json({ error: 'Interrupt not found' }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      type?: unknown;
      expected_version?: unknown;
      idempotency_key?: unknown;
      decision?: unknown;
    };
    if (body.type !== 'approve' && body.type !== 'reject') {
      return c.json({ error: "type must be 'approve' or 'reject'" }, 400);
    }
    if (!Number.isSafeInteger(body.expected_version) || Number(body.expected_version) < 1) {
      return c.json({ error: 'expected_version must be a positive integer' }, 400);
    }
    if (typeof body.idempotency_key !== 'string' || !IDEMPOTENCY_KEY_RE.test(body.idempotency_key)) {
      return c.json({ error: 'idempotency_key is malformed' }, 400);
    }
    const command = {
      type: body.type,
      interrupt_id: interrupt.id,
      expected_version: Number(body.expected_version),
      idempotency_key: body.idempotency_key,
      decision: body.decision ?? null,
    };
    try {
      assertSourceAdapterEnabled(run);
      // Re-check immediately before source mutation so a feature revocation
      // between the initial read and command parsing fails closed.
      if (!(await canAccessRunSource(user, run))) {
        throw new RuntimeKernelError('runtime_not_found', 'Runtime interrupt is not available');
      }
      const commandPayload = JSON.parse(JSON.stringify(command)) as RuntimeJsonValue;
      const replayed = await getDb().runtime.getEventByIdempotency(run.id, command.idempotency_key);
      if (replayed) {
        assertCommandReplay(replayed, 'interrupt.domain_commanded', commandPayload);
        return c.json({
          interrupt: interruptView((await getDb().runtime.getInterrupt(interrupt.id)) ?? interrupt),
          run: runView((await getDb().runtime.getRun(run.id)) ?? run),
          idempotent: true,
        });
      }
      const payload = parsePayload(interrupt.payload);
      if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
        throw new RuntimeKernelError('runtime_invalid_transition', 'Interrupt has no domain decision driver');
      }
      if (payload.source === 'mission_approval' && run.source_kind === 'agent_run') {
        const sourceRun = await getDb().agentRuns.getRunById(run.source_id);
        if (!sourceRun || typeof payload.approval_id !== 'string') {
          throw new RuntimeKernelError('runtime_not_found', 'Mission approval source is missing');
        }
        const target = body.type === 'approve' ? 'approved' : 'denied';
        let approval = await getDb().agentRuns.getApprovalById(payload.approval_id);
        if (!approval || approval.run_id !== sourceRun.id || approval.user_id !== sourceRun.user_id) {
          throw new RuntimeKernelError('runtime_not_found', 'Mission approval source is missing');
        }
        if (approval.status !== target) {
          if (interrupt.version !== command.expected_version) {
            throw new RuntimeKernelError(
              'runtime_version_conflict',
              `Runtime interrupt ${interrupt.id} changed concurrently`,
            );
          }
          if (approval.status !== 'pending') {
            throw new RuntimeKernelError(
              'runtime_invalid_transition',
              `Mission approval is already ${approval.status}`,
            );
          }
          if (getMissionRuntimeStatus().state !== 'ready') throw new Error('Mission runtime is unavailable');
          approval =
            (await getDb().agentRuns.decideApproval(
              payload.approval_id,
              sourceRun.id,
              sourceRun.user_id,
              body.type === 'approve' ? 'approve' : 'deny',
              user.id,
            )) ?? (await getDb().agentRuns.getApprovalById(payload.approval_id));
          if (approval?.status !== target) {
            throw new RuntimeKernelError('runtime_invalid_transition', 'Mission approval is no longer pending');
          }
        }
      } else if (payload.source === 'workflow_gate' && run.source_kind === 'workflow_run') {
        const gateId = Number(payload.gate_id);
        if (!Number.isSafeInteger(gateId)) {
          throw new RuntimeKernelError('runtime_not_found', 'Workflow gate source is missing');
        }
        const target = body.type === 'approve' ? 'approved' : 'rejected';
        let gate = await getDb().workflows.getGate(gateId);
        if (!gate || gate.run_id !== run.source_id) {
          throw new RuntimeKernelError('runtime_not_found', 'Workflow gate source is missing');
        }
        const note =
          body.decision && typeof body.decision === 'object' && !Array.isArray(body.decision)
            ? String((body.decision as Record<string, unknown>).note ?? '').slice(0, 2000) || undefined
            : undefined;
        if (gate.status !== target) {
          if (interrupt.version !== command.expected_version) {
            throw new RuntimeKernelError(
              'runtime_version_conflict',
              `Runtime interrupt ${interrupt.id} changed concurrently`,
            );
          }
          if (gate.status !== 'pending') {
            throw new RuntimeKernelError('runtime_invalid_transition', `Workflow gate is already ${gate.status}`);
          }
          try {
            await getWorkflowEngine().decideGate(gateId, {
              status: target,
              decided_by: user.id,
              note,
            });
          } catch (error) {
            gate = await getDb().workflows.getGate(gateId);
            if (gate?.status !== target) throw error;
          }
        }
      } else {
        throw new RuntimeKernelError('runtime_invalid_transition', 'Interrupt has no domain decision driver');
      }
      const mirrored =
        run.source_kind === 'agent_run'
          ? await mirrorMissionRunById(getDb(), run.source_id)
          : run.source_kind === 'workflow_run'
            ? await mirrorWorkflowRunById(getDb(), run.source_id)
            : null;
      if (!mirrored) throw new RuntimeKernelError('runtime_not_found', 'Runtime domain source is missing');
      const mirroredInterrupt = await getDb().runtime.getInterrupt(interrupt.id);
      if (!mirroredInterrupt) {
        throw new RuntimeKernelError('runtime_not_found', 'Runtime interrupt mirror is missing');
      }
      await recordDomainCommand({
        run: mirrored,
        type: 'interrupt.domain_commanded',
        command: commandPayload,
        idempotencyKey: command.idempotency_key,
        actorUserId: user.id,
        result: JSON.parse(
          JSON.stringify({ interrupt: interruptView(mirroredInterrupt), run: runView(mirrored) }),
        ) as RuntimeJsonValue,
      });
      return c.json({
        interrupt: interruptView(mirroredInterrupt),
        run: runView(mirrored),
      });
    } catch (error) {
      return runtimeError(c, error);
    }
  })
  .get('/summary', async (c) => {
    const user = getAuthUser(c);
    try {
      const scope = requestedScope(c.req.query('scope'), user.role === 'super');
      const kinds = await authorizedKinds(user, c.req.query('kinds'));
      const summary = await getDb().runtime.summarize({
        ...(scope === 'own' ? { owner_user_id: user.id, assignee_user_id: user.id } : {}),
        kinds,
      });
      return c.json(approvalInboxEnabled() ? summary : { ...summary, pending_interrupts: 0 });
    } catch (error) {
      const message = toErrorMessage(error);
      return c.json({ error: message }, /requires super|available to super/.test(message) ? 403 : 400);
    }
  });

export default runtimeRoutes;
