/** Exact reads prepared before private data enters a background run; never a general egress grant. */
import { and, eq, sql } from 'drizzle-orm';
import { getDb, runs, runSteps } from '@greenhouse/db';
import { z } from 'zod';
import { ApiError } from '../../http/errors.js';
import type { ConnectorReadAccess, ConnectorsService } from '../../modules/connectors/service.js';
import { callKey } from './assemble.js';
import type { ToolContext } from './define.js';

export const MAX_READ_AHEAD = 16;
export const MAX_READ_AHEAD_BYTES = 8192;
const MAX_RECORDED_READS = 90;

export const readAheadSchema = z
  .array(
    z
      .object({
        tool: z.string().min(1).max(200),
        arguments: z.record(z.string(), z.unknown()).default({}),
      })
      .strict(),
  )
  .min(1)
  .max(MAX_READ_AHEAD);

export interface ConnectorReadCall {
  action: 'call';
  connector: string;
  tool: string;
  arguments: Record<string, unknown>;
  read_ahead?: z.output<typeof readAheadSchema>;
}

type Context = Omit<ToolContext, 'stepId' | 'raise' | 'endTurn'>;
const stateSchema = z.object({
  version: z.literal(1),
  metadata_only: z.boolean().default(false),
  bindings: z.record(z.string(), z.string()),
  plan: z
    .object({
      run_id: z.string(),
      member_id: z.string(),
      connector_id: z.string(),
      binding: z.string(),
      keys: z.array(z.string()).max(MAX_READ_AHEAD + 1),
    })
    .optional(),
});
type ReadState = z.output<typeof stateSchema>;

/** read_ahead controls execution policy, not the remote operation or its saved-result identity. */
export function connectorReadKey(args: Omit<ConnectorReadCall, 'action'>): string {
  return callKey('mcp_call', {
    action: 'call',
    connector: args.connector,
    tool: args.tool,
    arguments: args.arguments,
  });
}

async function current(ctx: Context) {
  const [run] = await getDb()
    .select()
    .from(runs)
    .where(and(eq(runs.id, ctx.runId), eq(runs.ownerId, ctx.memberId), eq(runs.agentId, ctx.agent.id)));
  if (!run) throw new ApiError(403, 'connector_read_scope_changed', 'This connector read does not belong to the run.');
  const saved = stateSchema.safeParse(run.checkpoint?.connector_reads);
  return { run, state: saved.success ? saved.data : ({ version: 1, metadata_only: false, bindings: {} } as ReadState) };
}

async function save(ctx: Context, state: ReadState): Promise<void> {
  await getDb()
    .update(runs)
    .set({
      checkpoint: sql`jsonb_set(coalesce(${runs.checkpoint}, '{}'::jsonb), '{connector_reads}', ${JSON.stringify(state)}::jsonb)`,
    })
    .where(and(eq(runs.id, ctx.runId), eq(runs.ownerId, ctx.memberId), eq(runs.agentId, ctx.agent.id)));
}

/** Only local MCP metadata may precede planning. Unknown/event/public-page taint cannot seed a new plan. */
export async function noteConnectorMetadata(ctx: Context): Promise<void> {
  if (ctx.surface !== 'background' || ctx.tainted()) return;
  const { run, state } = await current(ctx);
  if (run.kind !== 'background' || run.checkpoint?.read_private || state.plan) return;
  state.metadata_only = true;
  await save(ctx, state);
}

async function cleanForPlanning(ctx: Context, state: ReadState): Promise<boolean> {
  if (!ctx.tainted()) return true;
  if (!state.metadata_only) return false;
  const steps = await getDb()
    .select({ tool: runSteps.toolName, input: runSteps.input, status: runSteps.status })
    .from(runSteps)
    .where(and(eq(runSteps.runId, ctx.runId), eq(runSteps.kind, 'tool')));
  return (
    steps.length > 0 &&
    steps.every(
      (step) =>
        step.tool === 'mcp_call' &&
        step.status === 'succeeded' &&
        (step.input.action === 'list' || step.input.action === 'describe'),
    )
  );
}

/** Recheck even on a cache hit. A saved result cannot move to a new account or survive local revocation. */
export async function checkConnectorRead(
  connectors: ConnectorsService,
  args: ConnectorReadCall,
  ctx: Context,
): Promise<ConnectorReadAccess> {
  const access = await connectors.readAccess(ctx.memberId, ctx.manifest, args.connector, args.tool);
  if (!access.tool.readOnly || access.tool.destructive)
    throw new ApiError(403, 'connector_background_read_only', 'Background runs can only read connector tools.');
  const { state } = await current(ctx);
  const key = connectorReadKey(args);
  if (
    state.plan?.keys.includes(key) &&
    (state.plan.run_id !== ctx.runId ||
      state.plan.member_id !== ctx.memberId ||
      state.plan.connector_id !== access.connector.id ||
      state.plan.binding !== access.binding)
  )
    throw new ApiError(403, 'connector_read_scope_changed', 'The connection changed after preparing this read.');
  const binding = state.bindings[key];
  if (binding && binding !== access.binding)
    throw new ApiError(403, 'connector_read_scope_changed', 'The connection or its read permissions changed.');
  if (!binding) {
    const [earlier] = await getDb()
      .select({ status: runSteps.status })
      .from(runSteps)
      .where(and(eq(runSteps.runId, ctx.runId), eq(runSteps.idempotencyKey, key)));
    if (earlier?.status === 'succeeded')
      throw new ApiError(403, 'connector_read_scope_changed', 'The saved result has no current credential binding.');
  }
  return access;
}

export async function prepareConnectorReads(
  connectors: ConnectorsService,
  args: ConnectorReadCall,
  ctx: Context,
  access: ConnectorReadAccess,
): Promise<void> {
  if (!args.read_ahead) return;
  if (
    args.read_ahead.length > MAX_READ_AHEAD ||
    Buffer.byteLength(JSON.stringify({ arguments: args.arguments, read_ahead: args.read_ahead }), 'utf8') >
      MAX_READ_AHEAD_BYTES
  )
    throw new ApiError(
      400,
      'connector_read_plan_limit',
      'Prepare at most 16 further reads and 8192 bytes of arguments.',
    );
  const { run, state } = await current(ctx);
  const keys = [
    ...new Set([
      connectorReadKey(args),
      ...args.read_ahead.map((read) => connectorReadKey({ ...read, connector: args.connector })),
    ]),
  ].sort();
  const plan: NonNullable<ReadState['plan']> = {
    run_id: ctx.runId,
    member_id: ctx.memberId,
    connector_id: access.connector.id,
    binding: access.binding,
    keys,
  };
  if (state.plan) {
    // The original call may be replayed after a crash; identical policy is not a new grant.
    if (JSON.stringify(state.plan) !== JSON.stringify(plan))
      throw new ApiError(403, 'connector_read_plan_locked', 'This run already has an immutable connector read plan.');
    return;
  }
  if (
    run.kind !== 'background' ||
    run.status !== 'running' ||
    run.desiredState !== 'run' ||
    run.requestedBy !== ctx.memberId ||
    ctx.eventWoken ||
    run.input.reason === 'event' ||
    run.checkpoint?.read_private === true ||
    !(await cleanForPlanning(ctx, state))
  )
    throw new ApiError(
      403,
      'connector_read_plan_locked',
      'Prepare exact reads before private or untrusted source data enters the run.',
    );
  for (const read of [{ tool: args.tool }, ...args.read_ahead]) {
    const checked = await connectors.readAccess(ctx.memberId, ctx.manifest, args.connector, read.tool);
    if (checked.binding !== access.binding)
      throw new ApiError(403, 'connector_read_scope_changed', 'The connection changed while preparing these reads.');
    if (!checked.trustedReadOnly || !checked.tool.readOnly || checked.tool.destructive)
      throw new ApiError(
        403,
        'connector_read_only_unverified',
        'An admin must vouch for every prepared read-only action.',
      );
  }
  state.plan = plan;
  state.metadata_only = false;
  // Commit the exact hashes before the first outbound call or private result. Retries keep this plan.
  await save(ctx, state);
}

export async function allowPreparedConnectorRead(
  connectors: ConnectorsService,
  args: ConnectorReadCall,
  ctx: Context,
): Promise<boolean> {
  const access = await checkConnectorRead(connectors, args, ctx);
  const { state } = await current(ctx);
  const plan = state.plan;
  if (!plan || !plan.keys.includes(connectorReadKey(args)))
    throw new ApiError(
      403,
      'connector_read_plan_required',
      'This run has read private data. These exact read arguments were not prepared beforehand; report the missing input and ask for a new task.',
    );
  if (
    plan.run_id !== ctx.runId ||
    plan.member_id !== ctx.memberId ||
    plan.connector_id !== access.connector.id ||
    plan.binding !== access.binding
  )
    throw new ApiError(403, 'connector_read_scope_changed', 'The connection or its read permissions changed.');
  if (!access.trustedReadOnly)
    throw new ApiError(
      403,
      'connector_read_only_unverified',
      'An admin must vouch for this prepared read-only action.',
    );
  return true;
}

/** Store the credential binding before the call; only the engine's later succeeded row permits reuse. */
export async function recordConnectorRead(
  connectors: ConnectorsService,
  args: ConnectorReadCall,
  ctx: Context,
): Promise<boolean> {
  const access = await checkConnectorRead(connectors, args, ctx);
  const { state } = await current(ctx);
  const key = connectorReadKey(args);
  if (!state.bindings[key] && Object.keys(state.bindings).length >= MAX_RECORDED_READS)
    throw new ApiError(400, 'connector_read_limit', 'This run reached its connector read limit.');
  state.bindings[key] = access.binding;
  state.metadata_only = false;
  await save(ctx, state);
  return access.private;
}

export async function connectorRunGuard(connectors: ConnectorsService, args: ConnectorReadCall, ctx: Context) {
  const access = await checkConnectorRead(connectors, args, ctx);
  const { state } = await current(ctx);
  return {
    manifest: ctx.manifest,
    binding: access.binding,
    trustedReadOnly: state.plan?.keys.includes(connectorReadKey(args)) ?? false,
  };
}
