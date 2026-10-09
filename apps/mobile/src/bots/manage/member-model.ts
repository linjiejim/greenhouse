/**
 * Membership and notes rules, React-free so the root vitest can run them
 * (./member-model.test.ts); bound to the store and the API in
 * ./use-conversation-info.ts and ./profile-tabs.tsx. A conversation is a Bot's
 * DM; other Bots join it as guests — a Bot brings one in itself when it wants
 * to hand work over (the member no longer invites by hand, 2026-10). Group
 * chats are retired (2026-10-09): an old group is a closed, read-only record —
 * nothing in it can be removed. The server is the judge (the owner rule); these
 * keep the profile from offering what it would refuse.
 */

import type { BotConversationDetail, BotMemberView, BotSharedNoteView } from '../../shared/bots';

// ─── Members ─────────────────────────────────────────────

/** Members in seat order (`position`). */
export function sortedMembers(members: readonly BotMemberView[]): BotMemberView[] {
  return [...members].sort((a, b) => a.position - b.position);
}

/** Who can be removed: a DM's guest — never its owner; nobody in a closed group. */
export function memberRemovable(conversation: Pick<BotConversationDetail, 'kind'>, member: BotMemberView): boolean {
  return conversation.kind === 'direct' && member.role === 'guest';
}

// ─── Optimistic edits (the server's answer replaces them) ─

/** A guest gone. */
export function withoutMember(detail: BotConversationDetail, botId: string): BotConversationDetail {
  return { ...detail, members: detail.members.filter((member) => member.bot_id !== botId) };
}

// ─── Shared notes ────────────────────────────────────────

/** Open before done, pinned first, then the most recently updated (the web's order). */
export function orderedNotes(notes: readonly BotSharedNoteView[]): BotSharedNoteView[] {
  const at = (note: BotSharedNoteView) => Date.parse(note.updated_at) || 0;
  return [...notes].sort(
    (a, b) =>
      Number(a.status === 'done') - Number(b.status === 'done') || Number(b.pinned) - Number(a.pinned) || at(b) - at(a),
  );
}
