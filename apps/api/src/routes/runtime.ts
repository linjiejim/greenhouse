/**
 * Runtime 统一执行读模型 — /api/runtime
 *
 * GET  /runs                              — 自己的任务；super 可 scope=all
 * GET  /runs/:id                          — 完整 run/step/tool/artifact/interrupt 详情
 * GET  /runs/:id/events                   — 永久事件的游标回放
 * POST /runs/:id/commands                 — 委派领域 driver 支持的 run 命令
 * GET  /interrupts                        — 待我处理；super 可 scope=all
 * GET  /summary                           — 执行中心与导航 badge 聚合
 */

import { Buffer } from 'node:buffer';
import { Hono, type Context } from 'hono';
import { getDb, RuntimeKernelError, type RuntimeRunRow } from '@greenhouse/db';
import {
  availableRuntimeUserActions,
  projectRuntimeForUser,
  RUNTIME_INTERRUPT_STATUSES,
  RUNTIME_RUN_COMMAND_TYPES,
  RUNTIME_RUN_KINDS,
  type RuntimeInterruptStatus,
  type RuntimeRunCommand,
  type RuntimeRunCommandType,
  type RuntimeRunKind,
  type RuntimeUserAction,
} from '@greenhouse/types/runtime';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { AppEnv } from '../app-env.js';
import { getAuthUser, type AuthUser } from '../auth/middleware.js';
import { delegateAutomationRuntimeCancel, settleQueuedAutomationCancellation } from '../scheduler/runtime-driver.js';
import { delegateSubagentRuntimeCancel, settleQueuedSubagentCancellation } from '../runtime/subagent-driver.js';
import {
  requireTrustedExecutionSurface,
  resolveTrustedExecutionSwitches,
  trustedExecutionBootPlan,
} from '../trusted-execution/kill-switches.js';
import {
  runtimeArtifactView as artifactView,
  runtimeEventView as eventView,
  runtimeInterruptView as interruptView,
  runtimeRunView as runView,
  runtimeStepView as stepView,
  runtimeToolCallView as toolCallView,
} from '../runtime/views.js';

const DEFAULT_TASK_KINDS = [
  'mission',
  'workflow',
  'automation',
  'subagent',
  'agent_write',
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
  return requested.filter((kind) => {
    if (kind === 'workflow' || kind === 'chat' || kind === 'eval') return false;
    return true;
  });
}

async function canAccessRunSource(user: AuthUser, run: RuntimeRunRow): Promise<boolean> {
  if (user.role === 'super') return true;
  if (run.kind === 'workflow' || run.source_kind === 'workflow_run' || run.kind === 'chat' || run.kind === 'eval') {
    return false;
  }
  // Missions were retired in v1.4: their historical runs stay readable by the
  // owner. The adapter always emitted this exact pair; anything else is denied.
  if (run.kind === 'mission' || run.source_kind === 'agent_run') {
    return run.kind === 'mission' && run.source_kind === 'agent_run';
  }
  if (run.kind === 'automation') return run.source_kind.startsWith('scheduled_task:');
  if (run.kind === 'subagent') return run.source_kind === 'spawned_session';
  // An external agent's write belongs to the member it acted for.
  if (run.kind === 'agent_write') return run.source_kind === 'proxy_call';
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
  return c.json({ error: toErrorMessage(error) }, 400);
}

async function ownedRun(c: Context<AppEnv>, id: string) {
  const user = getAuthUser(c);
  const run = await getDb().runtime.getRun(id);
  if (!run || (run.owner_user_id !== user.id && user.role !== 'super') || !(await canAccessRunSource(user, run))) {
    return null;
  }
  return run;
}

async function delegateRunCommand(run: RuntimeRunRow, type: RuntimeRunCommandType, mayDrive: boolean): Promise<void> {
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
      if (command.type === 'cancel' && commandedRun.kind === 'automation') {
        commandedRun = await settleQueuedAutomationCancellation(getDb(), commandedRun, user.id);
      } else if (command.type === 'cancel' && commandedRun.kind === 'subagent') {
        commandedRun = await settleQueuedSubagentCancellation(getDb(), commandedRun, user.id);
      }
      return c.json({ run: runView(commandedRun), ...(fenced.idempotent ? { idempotent: true } : {}) });
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
