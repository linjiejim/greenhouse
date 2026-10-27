/**
 * What my agents did and cost (1.6): my recent agent writes (`/api/agent-access/writes`, my own,
 * newest first, at most 50), this month's spend (`/api/usage/spend`, my own, USD micros) and my
 * model-gateway keys (`/api/agent-access/gateway`, never a secret). Internal members only.
 */

import type { AgentWrite, GatewayOverview, MySpend } from '../shared/greenhouse-types';
import { get } from './client';

export const listAgentWrites = () => get<{ writes: AgentWrite[] }>('/api/agent-access/writes');

export const mySpend = () => get<MySpend>('/api/usage/spend');

export const gatewayOverview = () => get<GatewayOverview>('/api/agent-access/gateway');

/** An external agent I connected (OAuth / MCP), as `/api/agent-access/connections` lists it. */
export interface AgentConnection {
  client_id: string;
  client_name: string;
  kind: 'codex' | 'claude-code' | 'cursor' | 'other';
  last_seen_at: string | null;
  connected_at: string;
  /** A plant the member chose for it, when the station keeps one. */
  avatar?: { plant?: string; tint?: string } | null;
}

export const listConnections = () => get<{ now: string; connections: AgentConnection[] }>('/api/agent-access/connections');
