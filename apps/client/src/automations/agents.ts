/**
 * Custom agents (run profiles, `/api/profiles/custom`, apps/api/src/routes/profiles.ts) as the
 * Automations place edits them: which ones are mine and which the team shares, the editor's
 * draft, its checks and the request body. React-free (./agents.test.ts).
 *
 * An agent is one current configuration (its `version` goes up on every edit); automations and
 * conversations pin it as `custom:<id>@<version>` and always run the current one. Only the owner
 * edits; a super alone shares one with the team.
 */

import { withPlant, type PlantId } from '../ui/plant-avatar/plant-ids';

/** apps/api/src/routes/profiles.ts */
export const AGENT_PROMPT_MAX = 8000;
export const AGENT_DEFAULT_MAX_STEPS = 12;
export const AGENT_MAX_STEPS = 50;
export const AGENT_DEFAULT_PLANT: PlantId = 'ivy';
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** A custom agent as `GET /api/profiles/custom` (and `/api/profiles`) sends it. */
export interface CustomAgent {
  /** `custom:<id>` */
  id: string;
  slug?: string;
  name: string;
  description?: string | null;
  base_profile_id?: string;
  tools?: string[];
  /** `mcp_call` narrowing: null = every connector its member can use. */
  connectors?: string[] | null;
  system_prompt?: string;
  max_steps?: number;
  is_shared?: boolean;
  is_custom?: boolean;
  user_id?: string;
  owner_nickname?: string;
  updated_at?: string;
  current_version?: number;
  purpose?: string | null;
  audience?: string | null;
  risk_level?: RiskLevel;
  avatar?: Record<string, unknown> | null;
  model_id?: string;
  usage?: { total_calls?: number; last_used_at?: string | null } | null;
}

/** `custom:01J…` → `01J…`, the id the `/custom/:id` routes take. */
export const agentRowId = (id: string) => id.replace(/^custom:/, '').replace(/@\d+$/, '');

/**
 * Mine, then the ones another member shares with the team, each by name. A super's list holds
 * every member's private agents too (the administration view); this place leaves them out.
 */
export function agentGroups(
  agents: readonly CustomAgent[],
  userId: string | null | undefined,
): { mine: CustomAgent[]; shared: CustomAgent[] } {
  const byName = (a: CustomAgent, b: CustomAgent) => a.name.localeCompare(b.name);
  return {
    mine: agents.filter((agent) => !!userId && agent.user_id === userId).sort(byName),
    shared: agents.filter((agent) => agent.user_id !== userId && agent.is_shared === true).sort(byName),
  };
}

/** How many of these automations run as the agent (any pinned version). */
export function automationsUsing(agentId: string, automations: readonly { profile_id: string }[]): number {
  const id = agentRowId(agentId);
  return automations.filter((task) => task.profile_id.startsWith('custom:') && agentRowId(task.profile_id) === id)
    .length;
}

// ─── Slugs ───────────────────────────────────────────────

/**
 * The slug the station derives from a name (routes/profiles.ts `slugify`, which keeps a-z, 0-9,
 * '-' and the CJK block U+4E00–U+9FFF); one per member.
 */
export function agentSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9一-鿿-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'profile'
  );
}

/** A copy's name whose slug none of my agents has yet: "Ops (copy)", then "Ops (copy 2)". */
export function copyName(name: string, mine: readonly { name: string }[], words: { one: string; many: string }) {
  const taken = new Set(mine.map((agent) => agentSlug(agent.name)));
  const fill = (template: string, n: number) => template.replace('{name}', name).replace('{n}', String(n));
  let candidate = fill(words.one, 1);
  for (let n = 2; taken.has(agentSlug(candidate)) && n < 100; n += 1) candidate = fill(words.many, n);
  return candidate;
}

// ─── Draft ───────────────────────────────────────────────

export interface AgentDraft {
  name: string;
  description: string;
  modelId: string;
  prompt: string;
  tools: string[];
  connectors: string[] | null;
  /** As typed; a whole number 1–50. */
  maxSteps: string;
  purpose: string;
  audience: string;
  riskLevel: RiskLevel;
  /** The stored avatar, changed only through withPlant / withTint so other keys survive. */
  avatar: Record<string, unknown>;
}

export function newAgentDraft(modelId: string): AgentDraft {
  return {
    name: '',
    description: '',
    modelId,
    prompt: '',
    tools: [],
    connectors: null,
    maxSteps: String(AGENT_DEFAULT_MAX_STEPS),
    purpose: '',
    audience: '',
    riskLevel: 'medium',
    avatar: withPlant({}, AGENT_DEFAULT_PLANT),
  };
}

export function agentDraftFrom(agent: CustomAgent, fallbackModel: string): AgentDraft {
  return {
    name: agent.name,
    description: agent.description ?? '',
    modelId: agent.model_id || fallbackModel,
    prompt: agent.system_prompt ?? '',
    tools: [...(agent.tools ?? [])],
    connectors: agent.connectors ? [...agent.connectors] : null,
    maxSteps: String(agent.max_steps ?? AGENT_DEFAULT_MAX_STEPS),
    purpose: agent.purpose ?? '',
    audience: agent.audience ?? '',
    riskLevel: agent.risk_level ?? 'medium',
    avatar: { ...(agent.avatar ?? {}) },
  };
}

/**
 * A duplicate is a new private agent of mine with the same configuration, keeping only the
 * tools I hold and the connectors I can use (another member's would be refused).
 */
export function duplicateAgentDraft(
  agent: CustomAgent,
  options: {
    name: string;
    fallbackModel: string;
    heldTools: readonly string[];
    usableConnectors: readonly string[] | null;
  },
): AgentDraft {
  const draft = agentDraftFrom(agent, options.fallbackModel);
  const held = new Set(options.heldTools);
  const usable = options.usableConnectors ? new Set(options.usableConnectors) : null;
  return {
    ...draft,
    name: options.name,
    tools: draft.tools.filter((id) => held.has(id)),
    connectors: draft.connectors && usable ? draft.connectors.filter((id) => usable.has(id)) : null,
  };
}

export type AgentDraftError = 'nameRequired' | 'nameTaken' | 'promptRequired' | 'promptLong' | 'maxSteps';
export type AgentDraftErrors = Partial<Record<'name' | 'prompt' | 'maxSteps', AgentDraftError>>;

const whole = (text: string) => (/^\d{1,3}$/.test(text.trim()) ? Number(text.trim()) : NaN);

/**
 * What stops the draft from saving. `others` are my other agents: the station refuses a second
 * one with the same slug (409), so the name says so first.
 */
export function validateAgentDraft(draft: AgentDraft, others: readonly { name: string }[]): AgentDraftErrors {
  const errors: AgentDraftErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = 'nameRequired';
  else if (others.some((agent) => agentSlug(agent.name) === agentSlug(name))) errors.name = 'nameTaken';
  const prompt = draft.prompt.trim();
  if (!prompt) errors.prompt = 'promptRequired';
  else if (prompt.length > AGENT_PROMPT_MAX) errors.prompt = 'promptLong';
  const steps = whole(draft.maxSteps);
  if (!(steps >= 1 && steps <= AGENT_MAX_STEPS)) errors.maxSteps = 'maxSteps';
  return errors;
}

/** `POST /api/profiles/custom` and `PUT /api/profiles/custom/:id` bodies. */
export interface AgentBody {
  name?: string;
  description?: string;
  base_profile_id?: string;
  model_id?: string;
  tools?: string[];
  connectors?: string[] | null;
  system_prompt?: string;
  max_steps?: number;
  purpose?: string;
  audience?: string;
  risk_level?: RiskLevel;
  avatar?: Record<string, unknown>;
}

/**
 * The request body. New: everything (a new agent starts from the default preset). Edit
 * (`original` given): only what changed, `{}` when nothing did — every saved edit raises the
 * agent's version, so an unchanged save is not sent at all.
 */
export function agentBody(draft: AgentDraft, original?: AgentDraft | null): AgentBody {
  const value: Required<Omit<AgentBody, 'base_profile_id'>> = {
    name: draft.name.trim(),
    description: draft.description.trim(),
    model_id: draft.modelId,
    tools: [...draft.tools],
    connectors: draft.connectors ? [...draft.connectors] : null,
    system_prompt: draft.prompt.trim(),
    max_steps: whole(draft.maxSteps),
    purpose: draft.purpose.trim(),
    audience: draft.audience.trim(),
    risk_level: draft.riskLevel,
    avatar: draft.avatar,
  };
  if (!original) return { ...value, base_profile_id: 'sprouty' };
  const before = agentBody(original);
  const body: AgentBody = {};
  for (const key of Object.keys(value) as (keyof typeof value)[]) {
    if (JSON.stringify(value[key]) !== JSON.stringify(before[key])) Object.assign(body, { [key]: value[key] });
  }
  return body;
}

export function agentDraftChanged(draft: AgentDraft, start: AgentDraft): boolean {
  return JSON.stringify(draft) !== JSON.stringify(start);
}

// ─── Tools ───────────────────────────────────────────────

/** `GET /api/tools`: the tools I hold (apps/api/src/routes/tools.ts). */
export interface ToolMeta {
  id: string;
  name: string;
  brief?: string;
  category?: string;
  /** Every agent has it whatever its author picks. */
  builtin?: boolean;
  surface?: { proxy?: 'read' | 'write' | string } | null;
}

export const TOOL_GROUPS = ['core', 'team', 'admin'] as const;

/**
 * The tools an agent's author chooses from, by group and filtered by `query`: built-ins are left
 * out (every agent has them). Selected tools I no longer hold come last in `missing`.
 */
export function toolPicker(
  tools: readonly ToolMeta[],
  selected: readonly string[],
  query: string,
): { groups: { id: string; tools: ToolMeta[] }[]; missing: string[]; pickable: string[] } {
  const pickable = tools.filter((tool) => !tool.builtin);
  const q = query.trim().toLowerCase();
  const hit = (tool: ToolMeta) =>
    !q || [tool.name, tool.id, tool.brief ?? ''].some((text) => text.toLowerCase().includes(q));
  const order = [...TOOL_GROUPS, ...new Set(pickable.map((tool) => tool.category || 'core'))].filter(
    (id, i, all) => all.indexOf(id) === i,
  );
  const groups = order
    .map((id) => ({ id, tools: pickable.filter((tool) => (tool.category || 'core') === id && hit(tool)) }))
    .filter((group) => group.tools.length > 0);
  const known = new Set(pickable.map((tool) => tool.id));
  const builtins = new Set(tools.filter((tool) => tool.builtin).map((tool) => tool.id));
  return {
    groups,
    missing: selected.filter((id) => !known.has(id) && !builtins.has(id)),
    pickable: pickable.map((tool) => tool.id),
  };
}
