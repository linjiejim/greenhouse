/**
 * Rooms (spec 20261011-agent-first-class P5, D42–D46): several people, and the Agents they bring,
 * in one conversation (`kind: 'room'`). Pure helpers every room surface shares — the sidebar row,
 * the page, the header, the transcript, the dialogs — so "what is it called, who is here, who may
 * I @, what may I take out" has one answer.
 *
 * The server decides everything (who may be added, which @ is answered, who may remove what); these
 * only read the room as the member sees it (`participants`, each Agent's `owner_user_id` /
 * `brought_by_user_id` / `addressable` / `profile`).
 */

import type { BotConversationSummary, BotMemberView, BotView, RoomParticipantView } from '@greenhouse/types/bots';

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
 * May the member take this Agent out? Whoever brought it, its owner and the room's owner may (the
 * server's rule; it still decides).
 */
export function canRemoveRoomAgent(
  member: BotMemberView,
  me: string | null | undefined,
  ownerId: string | null,
): boolean {
  if (!me) return false;
  return member.brought_by_user_id === me || member.owner_user_id === me || ownerId === me;
}

/**
 * How an Agent in the room looks to the member. Their own comes from their directory (it has their
 * latest edits); anyone else's from the room's `profile` — what the server shows this reader (a
 * public Agent's published version) — laid over the directory's copy when there is one (a public
 * Agent they also talk to). Null when neither knows it: an older server sends no `profile`, and
 * another person's own Agent is never in the member's directory (`roomAgentStandIn` then).
 */
export function roomAgentCard(
  member: BotMemberView,
  me: string | null | undefined,
  directory: ReadonlyMap<string, BotView>,
): BotView | null {
  const known = directory.get(member.bot_id);
  const profile = member.profile;
  if (!profile || (known && !!me && member.owner_user_id === me)) return known ?? null;
  return {
    ...(known ?? roomAgentStandIn(member, profile.name)),
    name: profile.name,
    role: profile.role,
    avatar: profile.avatar,
    template_key: profile.template_key,
  };
}

/**
 * The card for an Agent in the room nothing describes (`roomAgentCard` is null — an older server):
 * its owner's name stands in for its own ("Ana's Agent"); the face comes from its id, so it stays
 * the same plant. Also the base a `profile` is laid over.
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
