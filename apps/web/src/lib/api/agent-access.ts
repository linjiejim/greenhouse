/**
 * Agent access API — the current member's external agents: pending approvals,
 * recent writes, standing grants. See apps/api/src/routes/agent-access.ts.
 */

import type {
  AgentWriteGrantDayOption,
  AgentWriteGrantWire,
  AgentWritePendingView,
  AgentWriteView,
} from '@greenhouse/types/agent-access';
import { rpc } from './client';
import { authFetch } from '../auth';

function errorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object' || !('error' in value)) return fallback;
  return typeof value.error === 'string' ? value.error : fallback;
}

export interface AgentAccessOverview {
  mcp_url: string;
  legacy_confirm: boolean;
  pending_count: number;
  live_grant_count: number;
}

export interface AgentWriteTool {
  id: string;
  name: string;
  group: string | null;
}

export async function fetchAgentAccessOverview(): Promise<AgentAccessOverview> {
  const response = await rpc.api['agent-access'].overview.$get();
  const data = await response.json();
  if (!response.ok) throw new Error(errorMessage(data, `Unable to load agent access (${response.status})`));
  return data as AgentAccessOverview;
}

export async function fetchPendingAgentWrites(): Promise<AgentWritePendingView[]> {
  const response = await rpc.api['agent-access'].requests.$get({ query: { view: 'pending' } });
  const data = await response.json();
  if (!response.ok) throw new Error(errorMessage(data, `Unable to load approvals (${response.status})`));
  return (data as unknown as { requests: AgentWritePendingView[] }).requests;
}

export async function fetchRecentAgentWrites(): Promise<AgentWriteView[]> {
  const response = await rpc.api['agent-access'].requests.$get({ query: { view: 'recent' } });
  const data = await response.json();
  if (!response.ok) throw new Error(errorMessage(data, `Unable to load agent activity (${response.status})`));
  return (data as unknown as { requests: AgentWriteView[] }).requests;
}

export async function decideAgentWrite(
  interruptId: string,
  decision: 'approve' | 'reject',
  grantDays?: AgentWriteGrantDayOption,
): Promise<AgentWriteView> {
  const response = await authFetch(`/api/agent-access/requests/${encodeURIComponent(interruptId)}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, ...(grantDays ? { grant_days: grantDays } : {}) }),
  });
  const data: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(errorMessage(data, `Decision failed (${response.status})`));
  return (data as { request: AgentWriteView }).request;
}

export async function fetchAgentWriteGrants(): Promise<AgentWriteGrantWire[]> {
  const response = await rpc.api['agent-access'].grants.$get();
  const data = await response.json();
  if (!response.ok) throw new Error(errorMessage(data, `Unable to load standing grants (${response.status})`));
  return (data as unknown as { grants: AgentWriteGrantWire[] }).grants;
}

export async function createAgentWriteGrant(input: {
  tool_id: string;
  action: string | null;
  client_id: string | null;
  days: AgentWriteGrantDayOption;
}): Promise<void> {
  const response = await rpc.api['agent-access'].grants.$post({ json: input });
  if (!response.ok) {
    const data = await response.json().catch(() => undefined);
    throw new Error(errorMessage(data, `Unable to create the grant (${response.status})`));
  }
}

export async function revokeAgentWriteGrant(id: string): Promise<void> {
  const response = await rpc.api['agent-access'].grants[':id'].$delete({ param: { id } });
  if (!response.ok) {
    const data = await response.json().catch(() => undefined);
    throw new Error(errorMessage(data, `Unable to revoke the grant (${response.status})`));
  }
}

export async function fetchAgentWriteTools(): Promise<AgentWriteTool[]> {
  const response = await rpc.api['agent-access']['write-tools'].$get();
  const data = await response.json();
  if (!response.ok) throw new Error(errorMessage(data, `Unable to load write tools (${response.status})`));
  return data.tools;
}
