/**
 * Runtime ToolCall evidence at the actual AI SDK tool execution boundary.
 *
 * AI SDK 6.0.176 does await `experimental_onToolCallStart` / `Finish`, but its
 * internal `notify()` deliberately catches and ignores callback failures. Those
 * callbacks therefore cannot be an admission fence: a failed DB write would
 * still let `tool.execute()` run. We wrap the SDK `execute` function instead.
 * The SDK awaits that function, so the durable `running` row is a hard
 * prerequisite for side effects and the terminal write happens before the
 * tool result is released back to the model.
 */

import type { DatabaseProvider, RuntimeToolCallRow } from '@greenhouse/db';
import type { RuntimeActionRisk, RuntimePayload, RuntimeToolCallStatus } from '@greenhouse/types/runtime';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { ToolRegistry } from '../agent.js';
import { hashAgentToolInput } from '../cloud-agent/approval.js';

export interface RuntimeToolEvidenceScope {
  db: DatabaseProvider;
  runId: string;
  stepId: string;
  actorUserId: string;
  executionAuthority: { mode: 'leased'; workerId: string; leaseMs: number } | { mode: 'chat_projection' };
  /** Stable per execution surface, e.g. `chat` or `automation:<step-id>`. */
  idempotencyPrefix: string;
  /** Test/special-tool seam. Production catalog tools use the catalog resolver. */
  resolveRisk?: (toolName: string) => RuntimeActionRisk | Promise<RuntimeActionRisk>;
}

interface RunningToolCall {
  row: RuntimeToolCallRow;
  toolCallId: string;
}

function exactPayload(value: unknown): RuntimePayload {
  if (value === undefined) return null;
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString(10);
    if (item instanceof Error) {
      return {
        name: item.name,
        message: item.message,
        stack: item.stack ?? null,
        ...(item.cause !== undefined ? { cause: item.cause } : {}),
      };
    }
    return item;
  });
  return encoded === undefined ? null : (JSON.parse(encoded) as RuntimePayload);
}

/** Catalog metadata is the single risk source; unknown client-only tools are R1. */
async function catalogRisk(toolName: string): Promise<RuntimeActionRisk> {
  // Dynamic import avoids registry -> spawn_session -> subagent driver -> this
  // module becoming a module-initialization cycle.
  const { getToolMeta } = await import('../tools/registry.js');
  const meta = getToolMeta(toolName);
  if (!meta) return 'r1';
  if (meta.runtime_risk) return meta.runtime_risk;
  return meta.surface?.proxy === 'write' ? 'r2' : 'r0';
}

function toolKey(scope: RuntimeToolEvidenceScope, toolCallId: string): string {
  return `${scope.idempotencyPrefix}:${toolCallId}`;
}

async function beginToolCall(
  scope: RuntimeToolEvidenceScope,
  input: { toolCallId: string; toolName: string; args: unknown },
): Promise<RunningToolCall> {
  const risk = await (scope.resolveRisk ?? catalogRisk)(input.toolName);
  const key = toolKey(scope, input.toolCallId);
  const row = await scope.db.runtime.beginToolCallWithAuthority({
    run_id: scope.runId,
    step_id: scope.stepId,
    tool_name: input.toolName,
    input: exactPayload(input.args),
    canonical_input_hash: hashAgentToolInput(input.args),
    risk_level: risk,
    idempotency_key: key,
    actor_user_id: scope.actorUserId,
    ...(scope.executionAuthority.mode === 'leased'
      ? {
          worker_id: scope.executionAuthority.workerId,
          lease_ms: scope.executionAuthority.leaseMs,
        }
      : { projection_only: true }),
  });
  return { row, toolCallId: input.toolCallId };
}

function returnedError(output: unknown): string | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const error = (output as Record<string, unknown>).error;
  return typeof error === 'string' && error.length > 0 ? error : null;
}

async function markOutcomeUnknown(
  scope: RuntimeToolEvidenceScope,
  running: RunningToolCall,
  observed: RuntimePayload,
  persistenceError: unknown,
): Promise<void> {
  try {
    const latest = await scope.db.runtime.getToolCall(running.row.id);
    if (!latest || latest.status !== 'running') return;
    await scope.db.runtime.transitionToolCall({
      id: latest.id,
      expected_version: latest.version,
      to_status: 'uncertain',
      event_idempotency_key: `${toolKey(scope, running.toolCallId)}:uncertain`,
      actor_user_id: scope.actorUserId,
      output: observed,
      error_code: 'tool_outcome_persistence_failed',
      error_message: toErrorMessage(persistenceError),
    });
  } catch {
    // The original terminal-write error remains authoritative. Stale Run
    // reconciliation gets another chance to convert a surviving running row
    // to `uncertain`; never hide the failure from the AI SDK wrapper.
  }
}

async function finishToolCall(
  scope: RuntimeToolEvidenceScope,
  running: RunningToolCall,
  outcome: { success: true; output: unknown } | { success: false; error: unknown; canceled: boolean },
): Promise<void> {
  const key = toolKey(scope, running.toolCallId);
  const returnedFailure = outcome.success ? returnedError(outcome.output) : null;
  const status: RuntimeToolCallStatus = outcome.success
    ? returnedFailure
      ? 'failed'
      : 'succeeded'
    : outcome.canceled
      ? 'canceled'
      : 'failed';
  const exactOutput = outcome.success ? exactPayload(outcome.output) : exactPayload({ error: outcome.error });
  const errorMessage = outcome.success ? returnedFailure : toErrorMessage(outcome.error);
  try {
    await scope.db.runtime.transitionToolCall({
      id: running.row.id,
      expected_version: running.row.version,
      to_status: status,
      event_idempotency_key: `${key}:${status}`,
      actor_user_id: scope.actorUserId,
      output: exactOutput,
      ...(errorMessage
        ? {
            error_code: outcome.success ? 'tool_returned_error' : outcome.canceled ? 'tool_canceled' : 'tool_failed',
            error_message: errorMessage,
          }
        : {}),
    });
  } catch (error) {
    // The tool may already have changed external state. Preserve the observed
    // full output/error while explicitly refusing to claim a known outcome.
    await markOutcomeUnknown(scope, running, exactOutput, error);
    throw error;
  }
}

function requiredToolCallId(options: unknown): string {
  const value = options && typeof options === 'object' ? (options as { toolCallId?: unknown }).toolCallId : undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('AI SDK tool execution is missing its stable toolCallId');
  }
  return value;
}

function toolAbortSignal(options: unknown): AbortSignal | undefined {
  return options && typeof options === 'object' ? (options as { abortSignal?: AbortSignal }).abortSignal : undefined;
}

function throwIfToolAborted(options: unknown): void {
  const signal = toolAbortSignal(options);
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(signal.reason === undefined ? 'Tool execution was canceled' : String(signal.reason));
  error.name = 'AbortError';
  throw error;
}

/**
 * Clone a per-turn ToolRegistry and put Runtime evidence around every executable
 * tool. The shared registry is never mutated, so concurrent users cannot leak
 * one another's Run/Step attribution.
 */
export function instrumentRuntimeTools(tools: ToolRegistry | undefined, scope: RuntimeToolEvidenceScope): ToolRegistry {
  if (!tools) return {};
  const instrumented: ToolRegistry = {};
  for (const [toolName, definition] of Object.entries(tools)) {
    if (!definition || typeof definition !== 'object' || typeof definition.execute !== 'function') {
      instrumented[toolName] = definition;
      continue;
    }
    const original = definition.execute;
    instrumented[toolName] = {
      ...definition,
      execute: async (input: unknown, options: unknown) => {
        const toolCallId = requiredToolCallId(options);
        // A Chat stop acknowledges only after aborting this shared signal. A
        // tool already queued by the provider must not acquire fresh execution
        // authority after that acknowledgement, even if its DB projection has
        // not reached desired_state=cancel yet.
        throwIfToolAborted(options);
        // This await is the admission fence. If persistence fails, the original
        // execute function is never entered.
        const running = await beginToolCall(scope, { toolCallId, toolName, args: input });
        let originalReturned = false;
        try {
          // Close the stop-vs-admission wait window. There is no async yield
          // between this check and original.call(), so an acknowledged abort
          // cannot start a tool after the durable row becomes running.
          throwIfToolAborted(options);
          const output = await original.call(definition, input, options);
          originalReturned = true;
          await finishToolCall(scope, running, { success: true, output });
          return output;
        } catch (error) {
          // A terminal persistence error after a successful tool call has
          // already been handled above and must never be rewritten as though
          // the real tool itself failed.
          if (originalReturned) throw error;
          const abortSignal = toolAbortSignal(options);
          await finishToolCall(scope, running, {
            success: false,
            error,
            canceled: abortSignal?.aborted === true,
          });
          throw error;
        }
      },
    };
  }
  return instrumented;
}

/** Close evidence left open when a max-attempts=1 worker disappears. */
export async function settleOpenRuntimeToolCalls(
  db: DatabaseProvider,
  runId: string,
  mode: 'canceled' | 'uncertain',
  actorUserId?: string,
): Promise<void> {
  for (const call of await db.runtime.listToolCalls(runId)) {
    if (call.status === 'pending' || call.status === 'awaiting_approval') {
      await db.runtime.transitionToolCall({
        id: call.id,
        expected_version: call.version,
        to_status: 'canceled',
        event_idempotency_key: `runtime-tool-reconcile:${call.id}:canceled`,
        actor_user_id: actorUserId ?? null,
        output: null,
        error_code: 'tool_not_started',
        error_message: 'The Runtime ended before tool execution started',
      });
    } else if (call.status === 'running') {
      await db.runtime.transitionToolCall({
        id: call.id,
        expected_version: call.version,
        // `running` means the admission transaction committed, not that the
        // external side effect definitely started or stopped. After worker
        // loss neither cancel intent nor the absence of a returned value can
        // prove the external outcome, so reconciliation must stay conservative.
        to_status: 'uncertain',
        event_idempotency_key: `runtime-tool-reconcile:${call.id}:uncertain`,
        actor_user_id: actorUserId ?? null,
        output: null,
        error_code: 'tool_outcome_unknown',
        error_message:
          mode === 'canceled'
            ? 'The Runtime was canceled after tool execution was admitted, but the external outcome is unknown'
            : 'The worker disappeared after tool execution was admitted; the external outcome is unknown',
      });
    }
  }
}
