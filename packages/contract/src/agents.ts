import { z } from 'zod';
import { isoTime } from './common.js';
import { memberSummarySchema } from './members.js';
import { usageTotalsSchema } from './usage.js';

export const AGENT_NAME_MAX = 24;
export const AGENT_ROLE_MAX = 40;
export const AGENT_DESCRIPTION_MAX = 500;
export const AGENT_INSTRUCTIONS_MAX = 8000;
/** Active Agents per member, the main Agent not counted. */
export const MAX_AGENTS = 20;

/** A plant avatar: the species and an optional tint. Unknown plants render as the default. */
export const agentAvatarSchema = z.object({
  plant: z.string().max(40).optional(),
  tint: z.string().max(40).optional(),
});
export type AgentAvatar = z.infer<typeof agentAvatarSchema>;

/** `default`, `strong`, `fast`, or `instance/model`. */
export const modelRefSchema = z.string().trim().min(1).max(160);

/** Everything a version freezes. Each save appends one; `agent:<id>@<version>` pins it. */
export const agentManifestSchema = z.object({
  name: z.string().trim().min(1).max(AGENT_NAME_MAX),
  role: z.string().trim().max(AGENT_ROLE_MAX),
  description: z.string().trim().max(AGENT_DESCRIPTION_MAX),
  instructions: z.string().max(AGENT_INSTRUCTIONS_MAX),
  avatar: agentAvatarSchema,
  model: modelRefSchema,
  /** Skill ids it is equipped with. */
  skills: z.array(z.string()).max(50),
  /** Connector slugs it may use; null means every connector its owner can use. */
  connectors: z.array(z.string()).max(50).nullable(),
  /** Tool names it may use; null means all its owner may use. A list only narrows. */
  tools: z.array(z.string()).max(100).nullable(),
  /** May it ask to change shared objects (always behind the member's approval)? */
  write: z.boolean(),
});
export type AgentManifest = z.infer<typeof agentManifestSchema>;

export const agentSchema = z.object({
  id: z.string(),
  /** `main` for the main Agent, `agent:<id>` for the others. */
  handle: z.string(),
  name: z.string(),
  role: z.string(),
  description: z.string(),
  avatar: agentAvatarSchema,
  is_main: z.boolean(),
  owner_id: z.string(),
  /** Public: published to an audience (AGNT-13). */
  visibility: z.enum(['private', 'public']),
  /** The version its audience talks to; null while private. */
  published_version: z.number().int().nullable(),
  /** An admin paused it: its audience cannot talk to it; its owner still can. */
  paused_at: isoTime.nullable(),
  template_key: z.string().nullable(),
  current_version: z.number().int(),
  archived_at: isoTime.nullable(),
  last_active_at: isoTime.nullable(),
  created_at: isoTime,
  updated_at: isoTime,
});
export type Agent = z.infer<typeof agentSchema>;

/** The owner's view: the Agent with its current manifest. */
export const agentDetailSchema = agentSchema.extend({
  instructions: z.string(),
  model: z.string(),
  skills: z.array(z.string()),
  connectors: z.array(z.string()).nullable(),
  tools: z.array(z.string()).nullable(),
  write: z.boolean(),
  /** The conversation that opens from its profile: the main thread or its Agent thread. */
  conversation_id: z.string().nullable(),
});
export type AgentDetail = z.infer<typeof agentDetailSchema>;

/** `public`: other members' public Agents shared with me, not paused or archived. */
export const agentListQuerySchema = z.object({
  scope: z.enum(['mine', 'public', 'archived']).default('mine'),
});

/**
 * Someone else's public Agent as its audience sees it: the published version's name, role,
 * description and avatar (`current_version` is that version), and who made it.
 */
export const publicAgentSchema = agentSchema.extend({
  owner: memberSummarySchema,
  /** Replies per member per day; 0 is no limit. */
  daily_cap: z.number().int(),
});
export type PublicAgent = z.infer<typeof publicAgentSchema>;

export const AUDIENCE_TYPES = ['member', 'group', 'workspace'] as const;

/** Who may talk to a public Agent: members, groups, or the whole workspace (no id). */
export const audienceEntrySchema = z
  .object({ type: z.enum(AUDIENCE_TYPES), id: z.string().min(1).max(64).optional() })
  .refine((entry) => (entry.type === 'workspace') === (entry.id === undefined), {
    message: 'A member or group needs its id; the workspace has none.',
  });

/** Publishes a version (default: the current one) to an audience, or changes the pin or the audience. */
export const publicationInputSchema = z.object({
  version: z.number().int().min(1).optional(),
  audience: z.array(audienceEntrySchema).min(1).max(500),
  /** Each member who uses it gets their own copy of its computer. */
  computer: z.boolean().default(false),
  /** Replies per member per day, in their time zone; 0 is no limit. */
  daily_cap: z.number().int().min(0).max(10_000).default(0),
});
export type PublicationInput = z.input<typeof publicationInputSchema>;

/** The 发布 tab: the owner's view of a publication. */
export const publicationSchema = z.object({
  agent_id: z.string(),
  published: z.boolean(),
  /** The published version; null while private. */
  version: z.number().int().nullable(),
  current_version: z.number().int(),
  audience: z.array(z.object({ type: z.enum(AUDIENCE_TYPES), id: z.string().nullable(), name: z.string() })),
  computer: z.boolean(),
  daily_cap: z.number().int(),
  paused_at: isoTime.nullable(),
});
export type Publication = z.infer<typeof publicationSchema>;

/** 管理 → 公开 Agents (archived ones serve nobody and are left out): never what anyone said. */
export const adminPublicAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  avatar: agentAvatarSchema,
  owner: memberSummarySchema,
  published_version: z.number().int(),
  paused_at: isoTime.nullable(),
  /** Active members who may talk to it, its owner not counted. */
  audience_size: z.number().int(),
  /** This UTC month, by its audience (not its owner): usage, replies and how many people. */
  month: usageTotalsSchema.extend({ turns: z.number().int(), people: z.number().int() }),
});
export type AdminPublicAgent = z.infer<typeof adminPublicAgentSchema>;

const manifestInput = agentManifestSchema.partial();

/** From a template (its copy fills what is not given) or blank. */
export const createAgentInputSchema = manifestInput.extend({
  template_key: z.string().max(40).optional(),
});
export type CreateAgentInput = z.input<typeof createAgentInputSchema>;

export const updateAgentInputSchema = manifestInput.extend({
  /** Shown in the version history. */
  change_note: z.string().trim().max(200).optional(),
});
export type UpdateAgentInput = z.input<typeof updateAgentInputSchema>;

export const agentVersionSchema = z.object({
  version: z.number().int(),
  manifest: agentManifestSchema,
  change_note: z.string(),
  created_by: z.string().nullable(),
  created_at: isoTime,
});
export type AgentVersion = z.infer<typeof agentVersionSchema>;

export const MEMORY_CATEGORIES = ['fact', 'preference', 'person', 'project', 'procedure'] as const;

export const agentMemorySchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  title: z.string(),
  content: z.string(),
  category: z.string(),
  status: z.enum(['active', 'dormant', 'archived', 'superseded']),
  pinned: z.boolean(),
  source: z.string(),
  last_used_at: isoTime.nullable(),
  created_at: isoTime,
  updated_at: isoTime,
});
export type AgentMemory = z.infer<typeof agentMemorySchema>;

export const memoryInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  content: z.string().max(4000).default(''),
  category: z.enum(MEMORY_CATEGORIES).default('fact'),
  pinned: z.boolean().default(false),
});
export type MemoryInput = z.input<typeof memoryInputSchema>;

export const updateMemoryInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    content: z.string().max(4000),
    category: z.enum(MEMORY_CATEGORIES),
    pinned: z.boolean(),
    status: z.enum(['active', 'dormant', 'archived']),
  })
  .partial();
export type UpdateMemoryInput = z.infer<typeof updateMemoryInputSchema>;
