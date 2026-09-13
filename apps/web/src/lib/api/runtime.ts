/** Typed Runtime control-plane client for Execution Center and Approval Inbox. */

import type {
  RuntimeArtifact,
  RuntimeEvent,
  RuntimeInterrupt,
  RuntimePayload,
  RuntimeRun,
  RuntimeRunCommandType,
  RuntimeRunKind,
  RuntimeStep,
  RuntimeToolCall,
  RuntimeUserAction,
  RuntimeUserProjection,
} from '@greenhouse/types/runtime';
import { fetchJson, qs } from '../http';

export type RuntimeScope = 'own' | 'all';

export interface RuntimeRunListPage {
  runs: RuntimeRun[];
  next_cursor: string | null;
}

export interface RuntimeInterruptListItem {
  interrupt: RuntimeInterrupt;
  run: RuntimeRun;
}

export interface RuntimeInterruptListPage {
  items: RuntimeInterruptListItem[];
  next_cursor: string | null;
}

export interface RuntimeSummary {
  runs: {
    total: number;
    by_status: Record<string, number>;
    by_kind: Record<string, number>;
  };
  pending_interrupts: number;
}

export interface RuntimeRunDetail {
  run: RuntimeRun;
  events: RuntimeEvent[];
  steps: RuntimeStep[];
  tool_calls: RuntimeToolCall[];
  artifacts: RuntimeArtifact[];
  interrupts: RuntimeInterrupt[];
  projection: RuntimeUserProjection;
  capabilities: {
    commands: RuntimeRunCommandType[];
    actions: RuntimeUserAction[];
  };
}

interface RuntimeListOptions {
  scope?: RuntimeScope;
  kinds?: readonly RuntimeRunKind[];
  cursor?: string | null;
  limit?: number;
}

function runtimeKinds(kinds: readonly RuntimeRunKind[] | undefined): string | undefined {
  return kinds?.join(',');
}

function commandKey(subject: string, action: string): string {
  const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `web:${subject}:${action}:${nonce}`;
}

export async function listRuntimeRuns(options: RuntimeListOptions = {}): Promise<RuntimeRunListPage> {
  const query = qs({
    scope: options.scope ?? 'own',
    kinds: runtimeKinds(options.kinds),
    cursor: options.cursor ?? undefined,
    limit: options.limit === undefined ? undefined : String(options.limit),
  });
  // This single route branch makes hc instantiate the entire deeply chained
  // Runtime contract and exceeds TypeScript's recursion limit. Keep the shared
  // wire types explicit here and use the repository HTTP helper until Hono can
  // infer this branch without TS2589; authentication/error handling is unchanged.
  return fetchJson<RuntimeRunListPage>(`/api/runtime/runs${query}`);
}

export async function getRuntimeRun(runId: string): Promise<RuntimeRunDetail> {
  return fetchJson<RuntimeRunDetail>(`/api/runtime/runs/${encodeURIComponent(runId)}`);
}

export async function listRuntimeInterrupts(
  options: RuntimeListOptions & { status?: RuntimeInterrupt['status'] } = {},
): Promise<RuntimeInterruptListPage> {
  const query = qs({
    scope: options.scope ?? 'own',
    kinds: runtimeKinds(options.kinds),
    status: options.status ?? 'pending',
    cursor: options.cursor ?? undefined,
    limit: options.limit === undefined ? undefined : String(options.limit),
  });
  return fetchJson<RuntimeInterruptListPage>(`/api/runtime/interrupts${query}`);
}

export async function getRuntimeSummary(options: RuntimeListOptions = {}): Promise<RuntimeSummary> {
  const query = qs({
    scope: options.scope ?? 'own',
    kinds: runtimeKinds(options.kinds),
  });
  return fetchJson<RuntimeSummary>(`/api/runtime/summary${query}`);
}

export async function commandRuntimeRun(
  run: Pick<RuntimeRun, 'id' | 'version'>,
  type: RuntimeRunCommandType,
): Promise<RuntimeRun> {
  const body = await fetchJson<{ run: RuntimeRun }>(`/api/runtime/runs/${encodeURIComponent(run.id)}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type,
      expected_version: run.version,
      idempotency_key: commandKey(run.id, type),
    }),
  });
  return body.run;
}

export async function commandRuntimeInterrupt(
  interrupt: Pick<RuntimeInterrupt, 'id' | 'version'>,
  type: 'approve' | 'reject',
  decision: RuntimePayload | null = null,
): Promise<{ interrupt: RuntimeInterrupt; run: RuntimeRun }> {
  return fetchJson<{ interrupt: RuntimeInterrupt; run: RuntimeRun }>(
    `/api/runtime/interrupts/${encodeURIComponent(interrupt.id)}/commands`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type,
        expected_version: interrupt.version,
        idempotency_key: commandKey(interrupt.id, type),
        decision,
      }),
    },
  );
}
