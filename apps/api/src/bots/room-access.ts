/**
 * Who may do what with the Agents in a room (spec 20261011-agent-first-class P5, D44/D45).
 *
 * - An Agent answers in a room only when someone allowed to address it @-mentions it: its owner
 *   (their own Agent, main Agent included), or — for a public Agent — anyone in its audience. Each
 *   turn then runs as the person who asked (the chain's `rc.user`), so permissions, cards and
 *   budget are theirs.
 * - A public Agent someone brought in (not its owner) stays only while everyone in the room is in
 *   its audience; an owner's own Agent stays as long as its owner does.
 */

import type { BotConversationMemberRow, BotRow, ConversationWithMembers, DatabaseProvider } from '@greenhouse/db';
import type { RoomViewExtras } from './views.js';
import { publicBotFor } from './public.js';

/** Each Agent in the room → its owner, and the ones this reader may address. */
export async function roomAgentAccess(
  db: DatabaseProvider,
  readerId: string,
  members: readonly BotConversationMemberRow[],
): Promise<{ agentOwners: Map<string, string>; addressable: Set<string> }> {
  const agentOwners = new Map<string, string>();
  const addressable = new Set<string>();
  for (const member of members) {
    const bot = await db.bots.getBotById(member.bot_id);
    if (!bot) continue;
    agentOwners.set(bot.id, bot.user_id);
    if (await mayAddress(db, readerId, bot)) addressable.add(bot.id);
  }
  return { agentOwners, addressable };
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
    if (bot && (await mayAddress(db, authorId, bot))) out.push(id);
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
