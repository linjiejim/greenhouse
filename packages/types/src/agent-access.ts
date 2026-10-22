/**
 * Agent access — the wire shape of one external agent's write as members and
 * agents see it (apps/api/src/agent-access, Settings › Agent connections).
 */

import type { RuntimePayload } from './runtime.js';

/** Risk tier of a write: r1 own+reversible, r2 shared data, r3 irreversible. */
export type AgentWriteRisk = 'r1' | 'r2' | 'r3';

/** Why a write ran without a fresh decision, or `approved` when a member said yes. */
export type AgentWriteBasis = 'own_reversible' | 'standing_grant' | 'legacy_confirm' | 'approved';

export type AgentWriteStatus =
  | 'pending'
  | 'running'
  | 'executed'
  | 'failed'
  | 'rejected'
  | 'expired'
  | 'withdrawn'
  | 'superseded'
  | 'outcome_unknown';

export interface AgentWriteView {
  /** The Runtime run id; what the agent polls with `agent_write_status`. */
  request_id: string;
  status: AgentWriteStatus;
  tool_id: string;
  action: string | null;
  risk: AgentWriteRisk;
  client_id: string;
  client_name: string;
  basis: AgentWriteBasis | null;
  input: RuntimePayload;
  output: RuntimePayload | null;
  error: string | null;
  created_at: string;
  settled_at: string | null;
  expires_at: string | null;
  /** The approval interrupt, when the write needed one. */
  interrupt_id: string | null;
  decided_by_user_id: string | null;
}

/** A pending request as its approver sees it (owner differs for machine clients). */
export interface AgentWritePendingView extends AgentWriteView {
  owner_user_id: string;
  owner_nickname: string | null;
}

export const AGENT_WRITE_GRANT_DAY_OPTIONS = [1, 7, 30, 90] as const;
export type AgentWriteGrantDayOption = (typeof AGENT_WRITE_GRANT_DAY_OPTIONS)[number];

export interface AgentWriteGrantWire {
  id: string;
  user_id: string;
  client_id: string | null;
  client_name: string | null;
  tool_id: string;
  tool_name: string;
  action: string | null;
  created_via: 'approval' | 'settings';
  expires_at: string;
  revoked_at: string | null;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
}
