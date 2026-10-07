/**
 * AgentAvatar — an Agent profile's plant.
 *
 * Thin adapter over `<PlantAvatar/>` that passes the profile's identity: its
 * stored avatar and its id as the stable id (`custom:<id>` for custom Agents,
 * the profile id for system ones — the built-in `sprouty` resolves to the
 * sprout). No profile at all is the default agent.
 *
 * Static unless asked: pickers, chips, mention rows and tables never animate
 * (plant-avatar spec §6); hero sizes (≥ 80px) play a capped idle by default.
 */

import type { Profile } from '@greenhouse/types/api';
import { PlantAvatar, type PlantAvatarProps } from '@greenhouse/ui/components/plant-avatar';
import { DEFAULT_AGENT_ID } from '../../lib/agent-constants';

export function AgentAvatar({
  profile,
  ...props
}: { profile: Pick<Profile, 'id' | 'avatar'> | null | undefined } & Omit<
  PlantAvatarProps,
  'plant' | 'avatar' | 'templateKey' | 'stableId'
>) {
  return <PlantAvatar avatar={profile?.avatar ?? null} stableId={profile?.id || DEFAULT_AGENT_ID} {...props} />;
}
