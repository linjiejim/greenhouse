/**
 * The plant of an agent a member connected (Claude Code, Codex, Cursor …). React-free
 * (./agent-plant.test.ts). A plant the station stores for it (`avatar { plant, tint }`, chosen in
 * My Agents) wins; otherwise the client decides, so the same kind of agent looks the same for
 * everyone; an unknown client gets a stable plant from its name. Never the assistant's sprout.
 */

import { resolvePlantAvatar, type ResolvedPlantAvatar } from './plant-ids';

export type AgentClientKind = 'codex' | 'claude-code' | 'cursor' | 'other';

const BY_CLIENT: Record<Exclude<AgentClientKind, 'other'>, { plant: string; tint: string }> = {
  'claude-code': { plant: 'lavender', tint: 'coral' },
  codex: { plant: 'opuntia', tint: 'sky' },
  cursor: { plant: 'ginkgo', tint: 'gold' },
};

export function agentPlant(
  kind: string,
  name: string,
  avatar?: { plant?: string; tint?: string } | null,
): ResolvedPlantAvatar {
  const stored = avatar && typeof avatar.plant === 'string' ? avatar : null;
  const byClient = kind in BY_CLIENT ? BY_CLIENT[kind as keyof typeof BY_CLIENT] : null;
  return resolvePlantAvatar(stored ?? byClient, { stableId: `agent:${name || kind}` });
}

/** The client kind a write's client name suggests (writes carry the name only). */
export function clientKindOf(name: string): AgentClientKind {
  const n = name.toLowerCase();
  if (n.includes('claude')) return 'claude-code';
  if (n.includes('codex')) return 'codex';
  if (n.includes('cursor')) return 'cursor';
  return 'other';
}
