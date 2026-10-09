/**
 * `GET /api/sessions?profile=` — the conversation list narrowed to one agent.
 *
 * The filter names an identity (`sprouty` = the member's main Bot, `bot:<id>` =
 * one of their other Bots), but `sessions.profile_id` stores an identity under
 * several spellings and the list has to find them all:
 * - pinned versions: unattended runs and automations store `bot:<id>@<v>`;
 * - retired ids that resolve to it, never rewritten in stored rows: `team`,
 *   `default`, `sprouty-quick`, … → `sprouty` (`normalizeProfileId`), and a
 *   migrated custom Agent's `custom:<n>[@v]` → its Bot (`bots.legacy_custom_id`);
 * - the member's own Sprouty Bot by id: a Chat opened from that Bot's profile is
 *   stored as `bot:<its id>`, yet it is the same agent as `sprouty`.
 *
 * The references feed the SQL filter (`profileRefs` in `sessions.list`), so a
 * page holds only matching rows; the route's one-by-one backfills check the same
 * list with `matchesProfileRefs`.
 */

import type { DatabaseProvider } from '@greenhouse/db';
import type { SessionProfileFilter } from '@greenhouse/types/api';
import { isSproutyBot } from '@greenhouse/types/bots';
import { DEFAULT_PROFILE_ID, botProfileId, parseBotProfileReference, profileIdAliases } from '../profiles/profile.js';

/** The filter a raw `?profile=` value names, or null when it is malformed (the route answers 400). */
export function parseSessionProfileFilter(raw: string): SessionProfileFilter | null {
  if (raw === DEFAULT_PROFILE_ID) return DEFAULT_PROFILE_ID;
  const reference = parseBotProfileReference(raw);
  // Exactly `bot:<id>` — a pinned `@<v>` is not a filter (every version matches anyway).
  return reference && raw === botProfileId(reference.botId) ? (raw as SessionProfileFilter) : null;
}

/** `sprouty`, the retired ids folded into it, and the member's Sprouty Bot by id (when it exists yet). */
function sproutyRefs(sproutyBotId: string | null): string[] {
  return [...profileIdAliases(DEFAULT_PROFILE_ID), ...(sproutyBotId ? [botProfileId(sproutyBotId)] : [])];
}

/**
 * Every stored `profile_id` spelling of the agent a filter names, as this viewer
 * means it. The list query also matches each one's pinned versions (`<ref>@<v>`).
 */
export async function sessionProfileRefs(
  db: DatabaseProvider,
  viewerId: string,
  filter: SessionProfileFilter,
): Promise<string[]> {
  if (filter === DEFAULT_PROFILE_ID) {
    const sprouty = (await db.bots.listBots(viewerId)).find((bot) => isSproutyBot(bot));
    return sproutyRefs(sprouty?.id ?? null);
  }
  const reference = parseBotProfileReference(filter);
  if (!reference) return [filter];
  const bot = await db.bots.getBotById(reference.botId);
  // `sprouty` resolves to each member's OWN Sprouty, so only the viewer's names the same agent.
  if (bot && bot.user_id === viewerId && isSproutyBot(bot)) return sproutyRefs(bot.id);
  return [filter, ...(bot?.legacy_custom_id != null ? [`custom:${bot.legacy_custom_id}`] : [])];
}
