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
