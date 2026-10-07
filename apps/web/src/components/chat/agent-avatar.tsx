/**
 * AgentAvatar — an Agent profile's plant.
 *
 * Thin adapter over `<PlantAvatar/>` that passes the profile's identity: its
 * stored avatar and the Bot behind it as the stable id (`bot_id`; the profile
 * id for the hidden runtimes). No profile at all is the default agent.
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
}: { profile: Pick<Profile, 'id' | 'avatar' | 'bot_id' | 'template_key'> | null | undefined } & Omit<
  PlantAvatarProps,
  'plant' | 'avatar' | 'templateKey' | 'stableId'
>) {
  // A Bot-backed entry resolves a legacy avatar by the Bot's own id, so the
  // plant it shows here is the one its Bots conversations show.
  return (
    <PlantAvatar
      avatar={profile?.avatar ?? null}
      stableId={profile?.bot_id || profile?.id || DEFAULT_AGENT_ID}
      templateKey={profile?.template_key ?? undefined}
      {...props}
    />
  );
}
