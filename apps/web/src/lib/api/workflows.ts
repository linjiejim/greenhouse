/**
 * Workflows API — multi-agent workflow graphs: definitions, runs, gates.
 */

import type { WorkflowBudget, WorkflowGraph, WorkflowRunView } from '@greenhouse/types/workflow';
import { rpc } from './client';

export interface WorkflowDetail {
  id: number;
  name: string;
  status: string;
  version: number;
  graph: WorkflowGraph;
  created_from_session_id: string | null;
  updated_at: string;
}

export interface WorkflowRunSummary {
  id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
}

export async function getWorkflow(
  id: number,
): Promise<{ workflow: WorkflowDetail; runs: WorkflowRunSummary[] } | null> {
  try {
    const res = await rpc.api.workflows[':id'].$get({ param: { id: String(id) } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function getWorkflowRun(runId: string): Promise<WorkflowRunView | null> {
  try {
    const res = await rpc.api.workflows.runs[':runId'].$get({ param: { runId } });
    if (!res.ok) return null;
    return (await res.json()).run;
  } catch {
    return null;
  }
}

/** Save a plan-time graph edit; the server re-validates and bumps the version. */
export async function updateWorkflowGraph(id: number, graph: WorkflowGraph): Promise<{ version: number }> {
  // Non-literal arg: hc only types `json` for validator-backed routes (none here).
  const args = { param: { id: String(id) }, json: { graph } };
  const res = await rpc.api.workflows[':id'].$patch(args);
  const body = await res.json();
  if (!res.ok || !('workflow' in body)) {
    throw new Error('error' in body ? String(body.error) : `save failed: ${res.status}`);
  }
  return { version: body.workflow.version };
}

/** Latest run of the workflow drafted in this chat session — powers the run dock. */
export async function getLatestRunForSession(sessionId: string): Promise<WorkflowRunView | null> {
  try {
    const res = await rpc.api.workflows.runs.latest.$get({ query: { session_id: sessionId } });
    if (!res.ok) return null;
    const body = await res.json();
    return 'run' in body ? body.run : null;
  } catch {
    return null;
  }
}

export async function confirmWorkflow(
  id: number,
  taskInput: string,
  budget?: Partial<WorkflowBudget>,
): Promise<{ run_id: string }> {
  // Non-literal arg: hc only types `json` for validator-backed routes (none here).
  const args = { param: { id: String(id) }, json: { task_input: taskInput, budget } };
  const res = await rpc.api.workflows[':id'].confirm.$post(args);
  const body = await res.json();
  if (!res.ok || !('run_id' in body)) {
    throw new Error('error' in body ? String(body.error) : `confirm failed: ${res.status}`);
  }
  return body;
}

export async function cancelWorkflowRun(runId: string): Promise<void> {
  const res = await rpc.api.workflows.runs[':runId'].cancel.$post({ param: { runId } });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body && 'error' in body ? String(body.error) : `cancel failed: ${res.status}`);
  }
}

async function expectOk(
  res: { ok: boolean; status: number; json: () => Promise<unknown> },
  what: string,
): Promise<void> {
  if (res.ok) return;
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new Error(body?.error ?? `${what} failed: ${res.status}`);
}

export async function pauseWorkflowRun(runId: string): Promise<void> {
  await expectOk(await rpc.api.workflows.runs[':runId'].pause.$post({ param: { runId } }), 'pause');
}

export async function resumeWorkflowRun(runId: string): Promise<void> {
  await expectOk(await rpc.api.workflows.runs[':runId'].resume.$post({ param: { runId } }), 'resume');
}

export async function retryWorkflowNode(runId: string, nodeId: string): Promise<void> {
  const args = { param: { runId, nodeId } };
  await expectOk(await rpc.api.workflows.runs[':runId'].nodes[':nodeId'].retry.$post(args), 'retry');
}

export async function skipWorkflowNode(runId: string, nodeId: string): Promise<void> {
  const args = { param: { runId, nodeId } };
  await expectOk(await rpc.api.workflows.runs[':runId'].nodes[':nodeId'].skip.$post(args), 'skip');
}

export async function decideWorkflowGate(
  runId: string,
  gateId: number,
  status: 'approved' | 'rejected',
  note?: string,
): Promise<void> {
  // Non-literal arg: hc only types `json` for validator-backed routes (none here).
  const args = { param: { runId, gateId: String(gateId) }, json: { status, note } };
  const res = await rpc.api.workflows.runs[':runId'].gates[':gateId'].decide.$post(args);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body && 'error' in body ? String(body.error) : `gate decision failed: ${res.status}`);
  }
}
