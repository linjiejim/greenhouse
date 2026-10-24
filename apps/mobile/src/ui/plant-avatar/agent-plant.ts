/**
 * The plant of an agent a member connected (Claude Code, Codex, Cursor …). React-free
 * (./agent-plant.test.ts). The web's rule, from the vendored `plantForClient` (./plant-ids.ts):
 * a plant the station stores for it (`avatar { plant, tint }`, chosen in My Agents) wins;
 * otherwise the client name decides (Claude Code → fern, Codex → opuntia, Cursor → clover, any
 * other client a stable hash), so an agent looks the same on the web and the phone. Never the
 * assistant's sprout.
 */

import { plantForClient, resolvePlantAvatar, type ResolvedPlantAvatar } from './plant-ids';

export function agentPlant(name: string | null | undefined, avatar?: unknown): ResolvedPlantAvatar {
  const { plant, tint } = plantForClient(name, avatar);
  // the web seeds its loop phase the same way (client-agent-avatar.tsx)
  return resolvePlantAvatar({ plant, tint }, { stableId: `client:${name ?? ''}` });
}
