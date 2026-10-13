import { z } from 'zod';
import { isoTime } from './common.js';

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
  visibility: z.enum(['private', 'public']),
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

export const agentListQuerySchema = z.object({
  scope: z.enum(['mine', 'archived']).default('mine'),
});

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
