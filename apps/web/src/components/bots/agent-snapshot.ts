/**
 * "From an Agent": a new Bot starts as a snapshot of a custom Agent's name,
 * purpose, instructions and look (spec D2). A snapshot, not a reference — the
 * Bot does not follow the Agent's later versions, so an Agent's review and
 * publishing lifecycle never silently changes a Bot the member relies on.
 */

import { BOT_INSTRUCTIONS_MAX, BOT_NAME_MAX, BOT_ROLE_MAX } from '@greenhouse/types/bots';
import type { Profile } from '@greenhouse/types/api';
import type { BotDraft } from './bot-form';

/** Characters a Bot name may not hold (they would forge speaker tags). */
const NAME_FORBIDDEN = /[[\]:：\r\n]+/g;

function clip(value: string, max: number): string {
  return [...value].slice(0, max).join('').trim();
}

export function botDraftFromAgent(
  profile: Pick<Profile, 'name' | 'description' | 'purpose' | 'system_prompt' | 'avatar'>,
): BotDraft {
  const name = clip(profile.name.replace(NAME_FORBIDDEN, ' ').replace(/\s+/g, ' ').trim(), BOT_NAME_MAX);
  // A role is a few words: the first sentence of what the Agent is for.
  const purpose = (profile.purpose || profile.description || '').trim();
  const role = clip(purpose.split(/[\n。.!！?？]/)[0] ?? '', BOT_ROLE_MAX);
  const avatar = profile.avatar ?? {};
  return {
    name,
    role,
    instructions: clip(profile.system_prompt ?? '', BOT_INSTRUCTIONS_MAX),
    avatar: {
      ...(avatar.color ? { color: avatar.color } : {}),
      ...(avatar.accessories?.length ? { accessories: avatar.accessories.slice(0, 2) } : {}),
      ...(avatar.leafStyle ? { leafStyle: avatar.leafStyle } : {}),
      ...(avatar.faceStyle ? { faceStyle: avatar.faceStyle } : {}),
    },
    model_id: null,
  };
}
