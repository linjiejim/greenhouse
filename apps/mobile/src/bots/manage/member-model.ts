/**
 * Membership rules, React-free so the root vitest can run them
 * (./member-model.test.ts); bound to the store and the API in
 * ./use-conversation-info.ts (spec docs/specs/20261008-mobile-bots.md §2.5.7).
 * A conversation is a Bot's DM; other Bots join it as guests — a Bot brings one
 * in itself when it wants to hand work over, or the member invites one. Group
 * chats are retired (2026-10-09): an old group is a closed, read-only record —
 * nothing in it can be removed or invited. The server is the judge
 * (packages/db/src/services/bots.ts: `MAX_BOTS_PER_CONVERSATION`, the owner
 * rule); these keep the sheets from offering what it would refuse.
 */

import type { BotConversationDetail, BotMemberRole, BotMemberView, BotSharedNoteView, BotView } from '../../shared/bots';

/** Any conversation holds six Bots at most (the server's `MAX_BOTS_PER_CONVERSATION`). */
export const MAX_BOTS_PER_CONVERSATION = 6;

// ─── Members ─────────────────────────────────────────────

export type MemberLabel = BotMemberRole | 'archived';

/** The badge on a member row: its role, or "archived" for a Bot that no longer replies. */
export function memberLabel(member: BotMemberView, bot: Pick<BotView, 'status'> | null | undefined): MemberLabel {
  return bot?.status === 'archived' ? 'archived' : member.role;
}

/** Members in seat order (`position`). */
export function sortedMembers(members: readonly BotMemberView[]): BotMemberView[] {
  return [...members].sort((a, b) => a.position - b.position);
}

/** Who can be removed: a DM's guest — never its owner; nobody in a closed group. */
export function memberRemovable(conversation: Pick<BotConversationDetail, 'kind'>, member: BotMemberView): boolean {
  return conversation.kind === 'direct' && member.role === 'guest';
}

/** Room for one more guest (a closed group takes none). */
export function canInviteMore(conversation: Pick<BotConversationDetail, 'kind' | 'members'>): boolean {
  return conversation.kind === 'direct' && conversation.members.length < MAX_BOTS_PER_CONVERSATION;
}

/** Active Bots not in the conversation yet, in directory order. */
export function inviteCandidates(
  bots: readonly BotView[],
  conversation: Pick<BotConversationDetail, 'members'>,
): BotView[] {
  const here = new Set(conversation.members.map((member) => member.bot_id));
  return bots.filter((bot) => bot.status === 'active' && !here.has(bot.id));
}

// ─── Optimistic edits (the server's answer replaces them) ─

/** A guest gone. */
export function withoutMember(detail: BotConversationDetail, botId: string): BotConversationDetail {
  return { ...detail, members: detail.members.filter((member) => member.bot_id !== botId) };
}

// ─── Shared notes (read-only on mobile) ──────────────────

/** Open before done, pinned first, then the most recently updated (the web's order). */
export function orderedNotes(notes: readonly BotSharedNoteView[]): BotSharedNoteView[] {
  const at = (note: BotSharedNoteView) => Date.parse(note.updated_at) || 0;
  return [...notes].sort(
    (a, b) =>
      Number(a.status === 'done') - Number(b.status === 'done') || Number(b.pinned) - Number(a.pinned) || at(b) - at(a),
  );
}
