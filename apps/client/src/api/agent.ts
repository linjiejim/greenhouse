/**
 * What my agents did and cost (1.6): my recent agent writes (`/api/agent-access/writes`, my own,
 * newest first, at most 50), this month's spend (`/api/usage/spend`, my own, USD micros) and my
 * model-gateway keys (`/api/agent-access/gateway`, never a secret; creating one answers its secret
 * once, revoking needs no gateway switch). Internal members only.
 */

import type { AgentWrite, GatewayKey, GatewayKeyCreated, GatewayOverview, MySpend } from '../shared/greenhouse-types';
import { del, get, post, seg } from './client';

export const listAgentWrites = () => get<{ writes: AgentWrite[] }>('/api/agent-access/writes');

export const mySpend = () => get<MySpend>('/api/usage/spend');

export const gatewayOverview = () => get<GatewayOverview>('/api/agent-access/gateway');

/** 403 = the gateway is off; 409 = already at the active-key limit (the words say so). */
export const createGatewayKey = (name: string) => post<GatewayKeyCreated>('/api/agent-access/gateway/keys', { name });

export const revokeGatewayKey = (id: string) =>
  del<{ ok: true; key: GatewayKey }>(`/api/agent-access/gateway/keys/${seg(id)}`);

/** The station's MCP server address (`<origin>/api/mcp`), for the connect guide. */
export const agentAccessOverview = () => get<{ mcp_url: string }>('/api/agent-access/overview');

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
