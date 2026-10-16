/**
 * Agents on API v2 (`/api/agents`): the directory (mine, public, archived), a profile, new from
 * a template, edits (each save appends a version), archive and restore. `main` works as an id.
 * Shapes: ../shared/contract.ts. Every call answers an `ApiResult` (./client.ts), never throws.
 */

import type {
  Agent,
  AgentDetail,
  AgentMemory,
  AgentUsage,
  MemoryInput,
  UpdateMemoryInput,
  CreateAgentInput,
  PublicAgent,
  UpdateAgentInput,
} from '../shared/contract';
import { del, get, patch, post, seg } from './client';

const base = (id: string) => `/api/agents/${seg(id)}`;

/** My Agents (the main one included), or my archived ones. */
export const listAgents = (scope: 'mine' | 'archived' = 'mine') => get<{ items: Agent[] }>('/api/agents', { scope });

/** Other members' public Agents shared with me (talk to one through its Agent thread). */
export const listPublicAgents = () => get<{ items: PublicAgent[] }>('/api/agents', { scope: 'public' });

export const getAgent = (id: string) => get<AgentDetail>(base(id));

/** From a template (its copy fills what is not given) or blank. */
export const createAgent = (input: CreateAgentInput) => post<AgentDetail>('/api/agents', input);

export const updateAgent = (id: string, input: UpdateAgentInput) => patch<AgentDetail>(base(id), input);

/** Archive (the main Agent cannot be). */
export const archiveAgent = (id: string) => del(base(id));

export const restoreAgent = (id: string) => post<AgentDetail>(`${base(id)}/restore`);

export const agentMemories = (id: string) => get<{ items: AgentMemory[] }>(`${base(id)}/memories`);

export const agentUsage = (id: string) => get<AgentUsage>(`${base(id)}/usage`, { period: 'month' });
export const createMemory = (id: string, input: MemoryInput) => post<AgentMemory>(`${base(id)}/memories`, input);
export const updateMemory = (id: string, memory: string, input: UpdateMemoryInput) =>
  patch<AgentMemory>(`${base(id)}/memories/${seg(memory)}`, input);
export const forgetMemory = (id: string, memory: string) => del(`${base(id)}/memories/${seg(memory)}`);
