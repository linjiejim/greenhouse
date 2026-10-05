/**
 * "From an Agent": a new Bot starts as a snapshot of a custom Agent's name,
 * purpose, instructions and look (spec D2). A snapshot, not a reference — the
 * Bot does not follow the Agent's later versions, so an Agent's review and
 * publishing lifecycle never silently changes a Bot the member relies on.
 *
 * The look is pinned, not copied: the Agent's plant as it renders today (a
 * legacy avatar resolves by the Agent's own `custom:<id>`) and its resting mood.
 * Copying the legacy keys instead would re-resolve under the Bot's new id and
 * could land on a different plant.
 */

import { BOT_INSTRUCTIONS_MAX, BOT_NAME_MAX, BOT_ROLE_MAX } from '@greenhouse/types/bots';
import type { Profile } from '@greenhouse/types/api';
import { legacyToMood, withMood, withPlant } from '@greenhouse/types';
import { profilePlant } from '../../lib/plant-avatar';
import type { BotDraft } from './bot-form';

/** Characters a Bot name may not hold (they would forge speaker tags). */
const NAME_FORBIDDEN = /[[\]:：\r\n]+/g;

function clip(value: string, max: number): string {
  return [...value].slice(0, max).join('').trim();
}

export function botDraftFromAgent(
  profile: Pick<Profile, 'id' | 'name' | 'description' | 'purpose' | 'system_prompt' | 'avatar'>,
): BotDraft {
  const name = clip(profile.name.replace(NAME_FORBIDDEN, ' ').replace(/\s+/g, ' ').trim(), BOT_NAME_MAX);
  // A role is a few words: the first sentence of what the Agent is for.
  const purpose = (profile.purpose || profile.description || '').trim();
  const role = clip(purpose.split(/[\n。.!！?？]/)[0] ?? '', BOT_ROLE_MAX);
  return {
    name,
    role,
    instructions: clip(profile.system_prompt ?? '', BOT_INSTRUCTIONS_MAX),
    avatar: withMood(withPlant({}, profilePlant(profile)), legacyToMood(profile.avatar)),
    model_id: null,
  };
}
