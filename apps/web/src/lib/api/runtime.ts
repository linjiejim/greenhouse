/** Runtime run detail client — the page behind an agent write or an automation in the Activity log. */

import type {
  RuntimeArtifact,
  RuntimeEvent,
  RuntimeInterrupt,
  RuntimeRun,
  RuntimeRunCommandType,
  RuntimeStep,
  RuntimeToolCall,
  RuntimeUserAction,
  RuntimeUserProjection,
} from '@greenhouse/types/runtime';
import { fetchJson } from '../http';

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

function commandKey(subject: string, action: string): string {
  const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `web:${subject}:${action}:${nonce}`;
}

// The Runtime branch makes hc instantiate the entire deeply chained contract and
// exceeds TypeScript's recursion limit (TS2589), so these stay on the repository
// HTTP helper with the shared wire types; authentication and errors are unchanged.
export async function getRuntimeRun(runId: string): Promise<RuntimeRunDetail> {
  return fetchJson<RuntimeRunDetail>(`/api/runtime/runs/${encodeURIComponent(runId)}`);
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
