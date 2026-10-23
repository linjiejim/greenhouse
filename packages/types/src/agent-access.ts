/**
 * Agent access — the wire shape of one external agent's write as members and
 * agents see it (apps/api/src/agent-access, Settings › Agent connections).
 */

import type { RuntimePayload } from './runtime.js';

/** Risk tier of a write: r1 own+reversible, r2 shared data, r3 delete-like. */
export type AgentWriteRisk = 'r1' | 'r2' | 'r3';

/**
 * Why a write ran: `direct` — the member's own permissions allow it; `confirmed`
 * — a delete-like write the agent sent again with confirm:true after its preview.
 */
export type AgentWriteBasis = 'direct' | 'confirmed';

export const AGENT_WRITE_BASES: readonly AgentWriteBasis[] = ['direct', 'confirmed'];

export type AgentWriteStatus = 'running' | 'executed' | 'failed' | 'outcome_unknown';

/** One recorded write (a Runtime run of kind `agent_write`). */
export interface AgentWriteView {
  /** The Runtime run id. */
  request_id: string;
  status: AgentWriteStatus;
  tool_id: string;
  action: string | null;
  risk: AgentWriteRisk;
  client_id: string;
  client_name: string;
  basis: AgentWriteBasis | null;
  /** What the write targets, named for a person (the document title), when the member may read it. */
  target_label: string | null;
  input: RuntimePayload;
  output: RuntimePayload | null;
  error: string | null;
  created_at: string;
  settled_at: string | null;
}

/** What a delete-like write returns the first time: nothing has run yet. */
export interface AgentWritePreview {
  status: 'needs_confirmation';
  tool: string;
  action: string | null;
  risk: 'r3';
  /** The document title, when the member may read it. */
  target: string | null;
  input: RuntimePayload;
  message: string;
}
