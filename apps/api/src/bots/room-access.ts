/**
 * Who may do what with the Agents in a room (spec 20261011-agent-first-class P5, D44/D45).
 *
 * - Unaddressed messages are considered by available Agents. Explicit targets only wake those
 *   Agents; turns retain the original member's permissions, cards and budget. Owner-brought
 *   private Agents have a room-only face when another participant asks them.
 * - A public Agent someone brought in (not its owner) stays only while everyone in the room is in
 *   its audience; an owner's own Agent stays as long as its owner does.
 */

import type { BotConversationMemberRow, BotRow, ConversationWithMembers, DatabaseProvider } from '@greenhouse/db';
import type { AvatarConfig } from '@greenhouse/types/profile-manifest';
import { safeJsonParse } from '@greenhouse/utils/json';
import type { RoomAgentProfile, RoomViewExtras } from './views.js';
import { publicBotFor } from './public.js';
import { botsOwnerEligible } from './engine/run-slot.js';

/** Owner-brought private Agents may use only the room face while their owner remains eligible. */
export async function roomGuestBot(db: DatabaseProvider, member: BotConversationMemberRow): Promise<BotRow | null> {
  const bot = await db.bots.getBotById(member.bot_id);
  if (!bot || bot.status !== 'active' || bot.visibility === 'public' || member.user_id !== bot.user_id) return null;
  if (
    !(await db.bots.isParticipant(member.session_id, bot.user_id)) ||
    !(await botsOwnerEligible(db, await db.users.getById(bot.user_id)))
  )
    return null;
  return bot;
}

/**
 * Each Agent in the room → its owner, how to show it (a public one as its published version, so
 * nobody sees an owner's unpublished edits), and the ones this reader may address.
 */
export async function roomAgentAccess(
  db: DatabaseProvider,
  readerId: string,
  members: readonly BotConversationMemberRow[],
): Promise<Pick<RoomViewExtras, 'agentOwners' | 'addressable' | 'profiles'>> {
  const agentOwners = new Map<string, string>();
  const addressable = new Set<string>();
  const profiles = new Map<string, RoomAgentProfile>();
  for (const member of members) {
    const bot = await db.bots.getBotById(member.bot_id);
    if (!bot) continue;
    agentOwners.set(bot.id, bot.user_id);
    const offered = bot.user_id === readerId ? null : await publicBotFor(db, readerId, bot.id);
    if (
      bot.user_id === readerId ? bot.status === 'active' : offered !== null || (await roomGuestBot(db, member)) !== null
    )
      addressable.add(bot.id);
    const shown = bot.user_id === readerId ? bot : (offered ?? (await publishedFace(db, bot)));
    profiles.set(bot.id, {
      name: shown.name,
      role: shown.role,
      avatar: safeJsonParse(shown.avatar, {}) as AvatarConfig,
      template_key: shown.template_key,
    });
  }
  return { agentOwners, addressable, profiles };
}

/** Someone else's Agent this reader may not address: its published version if any, else its row. */
async function publishedFace(
  db: DatabaseProvider,
  bot: BotRow,
): Promise<Pick<BotRow, 'name' | 'role' | 'avatar' | 'template_key'>> {
  if (bot.visibility !== 'public' || bot.published_version === null) return bot;
  const version = await db.bots.getVersion(bot.id, bot.published_version);
  return version
    ? { name: version.name, role: version.role, avatar: version.avatar, template_key: bot.template_key }
    : bot;
}

/** May this person @ this Agent: their own (active), or a public one offered to them. */
export async function mayAddress(db: DatabaseProvider, userId: string, bot: BotRow): Promise<boolean> {
  if (bot.user_id === userId) return bot.status === 'active';
  return (await publicBotFor(db, userId, bot.id)) !== null;
}

/** The @-mentions of a room message this author may make (the rest are dropped, never answered). */
export async function addressableMentions(
  db: DatabaseProvider,
  authorId: string,
  conversation: Pick<ConversationWithMembers, 'members'>,
  mentions: readonly string[],
): Promise<string[]> {
  const inRoom = new Set(conversation.members.map((m) => m.bot_id));
  const out: string[] = [];
  for (const id of new Set(mentions)) {
    if (!inRoom.has(id)) continue;
    const bot = await db.bots.getBotById(id);
    const member = conversation.members.find((m) => m.bot_id === id)!;
    if (bot && ((await mayAddress(db, authorId, bot)) || (await roomGuestBot(db, member)))) out.push(id);
  }
  return out;
}

/** May a public Agent brought by someone else sit with all these people (D45)? */
export async function offeredToEveryone(
  db: DatabaseProvider,
  bot: Pick<BotRow, 'id' | 'user_id'>,
  peopleIds: readonly string[],
): Promise<boolean> {
  for (const id of peopleIds) {
    if (id === bot.user_id) continue;
    if (!(await publicBotFor(db, id, bot.id))) return false;
  }
  return true;
}

/** A room as this reader sees it (people, whose Agent each one is, which they may @). */
export async function roomViewExtras(
  db: DatabaseProvider,
  readerId: string,
  conversation: ConversationWithMembers,
): Promise<RoomViewExtras> {
  const participants = (await db.bots.listParticipants([conversation.session_id])).get(conversation.session_id) ?? [];
  return { readerId, participants, ...(await roomAgentAccess(db, readerId, conversation.members)) };
}
