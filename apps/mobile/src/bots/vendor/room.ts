// VENDORED from apps/web/src/components/bots/room.ts — verbatim below the imports (apps/mobile cannot
// import the web app; see apps/mobile/AGENTS.md). Only the import path differs. Do not edit here:
// change the canonical file, re-copy it, and run src/bots/vendor/vendor.parity.test.ts.

/**
 * Rooms (spec 20261011-agent-first-class P5, D42–D46): several people, and the Agents they bring,
 * in one conversation (`kind: 'room'`). Pure helpers every room surface shares — the sidebar row,
 * the page, the header, the transcript, the dialogs — so "what is it called, who is here, who may
 * I @, what may I take out" has one answer.
 *
 * The server decides everything (who may be added, which @ is answered, who may remove what); these
 * only read the room as the member sees it (`participants`, each Agent's `owner_user_id` /
 * `addressable`).
 */

import type { BotConversationSummary, BotMemberView, BotView, RoomParticipantView } from '../../shared/bots';

type RoomLike = Pick<BotConversationSummary, 'kind' | 'title' | 'members' | 'participants'>;

export function isRoom(conversation: Pick<BotConversationSummary, 'kind'> | null | undefined): boolean {
  return conversation?.kind === 'room';
}

/** Everyone in it but the member, in the order they joined. */
export function roomOthers(
  conversation: Pick<BotConversationSummary, 'participants'>,
  me: string | null | undefined,
): RoomParticipantView[] {
  return (conversation.participants ?? []).filter((person) => person.user_id !== me);
}

/**
 * Two people, no title, no Agents: the pair's private chat (one per pair, server-side) — it reads
 * as the other person.
 */
export function isPrivateChat(conversation: RoomLike): boolean {
  return (
    conversation.kind === 'room' &&
    (conversation.participants?.length ?? 0) === 2 &&
    !conversation.title?.trim() &&
    conversation.members.length === 0
  );
}

/** A room's name: its own title, else the other people's names, else `empty` (everyone else left). */
export function roomTitle(
  conversation: Pick<BotConversationSummary, 'title' | 'participants'>,
  me: string | null | undefined,
  empty: string,
): string {
  const title = conversation.title?.trim();
  if (title) return title;
  const names = roomOthers(conversation, me).map((person) => person.nickname);
  return names.length > 0 ? names.join(', ') : empty;
}

/** Who owns the room now (its creator, or whom it passed to when they left). */
export function roomOwnerId(conversation: Pick<BotConversationSummary, 'participants'>): string | null {
  return conversation.participants?.find((person) => person.role === 'owner')?.user_id ?? null;
}

/** A person's name as the room knows it; null for someone no longer in it. */
export function personName(
  conversation: Pick<BotConversationSummary, 'participants'>,
  userId: string | null | undefined,
): string | null {
  if (!userId) return null;
  return conversation.participants?.find((person) => person.user_id === userId)?.nickname ?? null;
}

/**
 * May the member take this Agent out? Its owner and the room's owner may. (The server also lets
 * whoever brought it, which the room view does not say — a public Agent the member brought into a
 * room someone else owns is removed by its owner or the room's.)
 */
export function canRemoveRoomAgent(
  member: BotMemberView,
  me: string | null | undefined,
  ownerId: string | null,
): boolean {
  if (!me) return false;
  return member.owner_user_id === me || ownerId === me;
}

/**
 * The card for an Agent in the room the member's directory does not have — another person's own
 * Agent (never in the member's Bot list) or a public one they have not talked to. Its owner's name
 * stands in for its own ("Ana's Agent"); the face comes from its id, so it stays the same plant.
 */
export function roomAgentStandIn(member: Pick<BotMemberView, 'bot_id' | 'owner_user_id'>, name: string): BotView {
  return {
    id: member.bot_id,
    name,
    role: '',
    description: '',
    instructions: '',
    avatar: {},
    model_id: null,
    tools: [],
    connectors: [],
    max_steps: null,
    template_key: null,
    status: 'active',
    dm_session_id: null,
    current_version: 0,
    user_id: member.owner_user_id ?? '',
    last_active_at: null,
    created_at: '',
    updated_at: '',
  };
}
