/**
 * Agent access API — the current member's external agents: the MCP endpoint
 * and their recorded writes. See apps/api/src/routes/agent-access.ts.
 */

import type { AgentWriteView } from '@greenhouse/types/agent-access';
import { rpc } from './client';

function errorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object' || !('error' in value)) return fallback;
  return typeof value.error === 'string' ? value.error : fallback;
}

export interface AgentAccessOverview {
  mcp_url: string;
}

export async function fetchAgentAccessOverview(): Promise<AgentAccessOverview> {
  const response = await rpc.api['agent-access'].overview.$get();
  const data = await response.json();
  if (!response.ok) throw new Error(errorMessage(data, `Unable to load agent access (${response.status})`));
  return data as AgentAccessOverview;
}

export async function fetchRecentAgentWrites(): Promise<AgentWriteView[]> {
  const response = await rpc.api['agent-access'].writes.$get();
  const data = await response.json();
  if (!response.ok) throw new Error(errorMessage(data, `Unable to load agent activity (${response.status})`));
  return (data as unknown as { writes: AgentWriteView[] }).writes;
}
