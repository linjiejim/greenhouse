/**
 * The plant avatar a member picks for one of their connected agents (Settings →
 * My agents). Stored on the member's OAuth grant (`oauth_grants.avatar`); null
 * means "the default for its client" (Claude Code, Codex, Cursor each get one —
 * the renderer decides). Vocabulary matches the plant renderer ported from v2:
 * append only, never rename.
 */

import { z } from 'zod';

export const AGENT_AVATAR_PLANTS = [
  'sprout',
  'ivy',
  'sage',
  'basil',
  'fern',
  'clover',
  'monstera',
  'ginkgo',
  'maple',
  'echeveria',
  'opuntia',
  'lotus',
  'eucalyptus',
  'lavender',
  'sunflower',
  'dandelion',
] as const;
export type AgentAvatarPlant = (typeof AGENT_AVATAR_PLANTS)[number];

/** `plant` = the species' own colour. */
export const AGENT_AVATAR_TINTS = ['plant', 'sky', 'violet', 'rose', 'coral', 'gold', 'teal'] as const;
export type AgentAvatarTint = (typeof AGENT_AVATAR_TINTS)[number];

export interface AgentAvatar {
  plant: AgentAvatarPlant;
  tint: AgentAvatarTint;
}

export const agentAvatarSchema = z
  .object({
    plant: z.enum(AGENT_AVATAR_PLANTS),
    tint: z.enum(AGENT_AVATAR_TINTS),
  })
  .strict();

/** Body of `PATCH /api/agent-access/connections/:clientId`; `avatar: null` restores the default. */
export const agentConnectionPatchSchema = z.object({ avatar: agentAvatarSchema.nullable() }).strict();
