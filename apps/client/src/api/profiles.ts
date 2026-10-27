/**
 * The agents a member may chat with or run automations as (`GET /api/profiles`): the built-in
 * assistant (Sprouty) first, then the member's own and team-shared custom agents (`custom:<id>`),
 * with the chat models the station can reach. Custom agents themselves (run profiles) are kept
 * under `/api/profiles/custom` (apps/api/src/routes/profiles.ts): only the owner edits one, and
 * only a super shares one with the team. The tools an agent may be given are the member's own
 * (`GET /api/tools`). Every call answers an `ApiResult`, never throws.
 */

import type { AgentBody, CustomAgent, ToolMeta } from '../automations/agents';
import { del, get, post, put, seg, type ApiResult } from './client';

export interface AgentProfile {
  id: string;
  name: string;
  name_i18n?: Record<string, string> | null;
  description?: string | null;
  is_custom?: boolean;
  /** Custom agents: the owner, and whether the team may use it. */
  user_id?: string;
  is_shared?: boolean;
  current_version?: number;
  avatar?: Record<string, unknown> | null;
  model_id?: string;
}

/** A chat model the station can run (`GET /api/profiles` `models`). */
export interface ChatModel {
  id: string;
  name: string;
}

export const listProfiles = async (): Promise<ApiResult<AgentProfile[]>> => {
  const result = await get<{ profiles: AgentProfile[] }>('/api/profiles');
  return result.ok ? { ok: true, data: result.data.profiles ?? [] } : result;
};

/** The agents and the models the station can run, in one read. */
export const listProfileCatalog = async (): Promise<ApiResult<{ profiles: AgentProfile[]; models: ChatModel[] }>> => {
  const result = await get<{ profiles?: AgentProfile[]; models?: ChatModel[] }>('/api/profiles');
  return result.ok
    ? { ok: true, data: { profiles: result.data.profiles ?? [], models: result.data.models ?? [] } }
    : result;
};

/** Custom agents I can see: mine and the team's (a super's list also holds every member's private ones). */
export const listCustomAgents = async (): Promise<ApiResult<CustomAgent[]>> => {
  const result = await get<{ profiles: CustomAgent[] }>('/api/profiles/custom');
  return result.ok ? { ok: true, data: result.data.profiles ?? [] } : result;
};

/** `id` is the bare row id (src/automations/agents.ts `agentRowId`). */
export const createCustomAgent = (body: AgentBody) => post<CustomAgent>('/api/profiles/custom', body);

export const updateCustomAgent = (id: string, body: AgentBody) =>
  put<CustomAgent>(`/api/profiles/custom/${seg(id)}`, body);

export const deleteCustomAgent = (id: string) => del<{ success: true }>(`/api/profiles/custom/${seg(id)}`);

/** Super only: whether the whole team may use the agent. */
export const setCustomAgentShared = (id: string, shared: boolean) =>
  put<CustomAgent>(`/api/profiles/custom/${seg(id)}/sharing`, { is_shared: shared });

/** The tools I hold (an agent can be given these, an automation granted some of them). */
export const listMyTools = async (): Promise<ApiResult<ToolMeta[]>> => {
  const result = await get<{ tools: ToolMeta[] }>('/api/tools');
  return result.ok ? { ok: true, data: result.data.tools ?? [] } : result;
};

/** A profile's name in the app's language (`name_i18n`, else the name). */
export function profileName(profile: Pick<AgentProfile, 'name' | 'name_i18n'>, lang: string): string {
  return profile.name_i18n?.[lang] || profile.name;
}

/** The profile a pinned reference (`custom:<id>@<version>`) names, if listed. */
export function findProfile(profiles: readonly AgentProfile[], ref: string | null | undefined): AgentProfile | null {
  const id = ref?.replace(/@\d+$/, '');
  return (id && profiles.find((profile) => profile.id === id)) || null;
}
