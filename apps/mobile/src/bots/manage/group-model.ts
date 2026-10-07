/**
 * Group and membership rules, React-free so the root vitest can run them
 * (./use-group-form.test.ts, ./use-conversation-info.test.ts); bound to the
 * store and the API in ./use-group-form.ts and ./use-conversation-info.ts
 * (spec docs/specs/20261008-mobile-bots.md §2.5.7). The server is the judge
 * (packages/db/src/services/bots.ts: `MAX_BOTS_PER_CONVERSATION`, the lead
 * and owner rules); these keep the sheets from offering what it would refuse.
 */

import type {
  BotConversationDetail,
  BotMemberRole,
  BotMemberView,
  BotSharedNoteView,
  BotView,
} from '../../shared/bots';
import { isSproutyBot } from '../../shared/bots';

/** A group has two Bots at least; any conversation six at most (the server's `MAX_BOTS_PER_CONVERSATION`). */
export const GROUP_MIN_BOTS = 2;
export const MAX_BOTS_PER_CONVERSATION = 6;
/** The server's caps on a group's name and rules (apps/api/src/bots/routes.ts). */
export const GROUP_TITLE_MAX = 80;
export const GROUP_RULES_MAX = 2000;

// ─── New group ───────────────────────────────────────────

/** The Bots a group can be made of: every active Bot, the member's main one first. */
export function groupCandidates(bots: readonly BotView[]): BotView[] {
  return [...bots.filter(isSproutyBot), ...bots.filter((bot) => !isSproutyBot(bot))];
}

/**
 * Tap a Bot in the new-group list: picks are kept in tap order (the first
 * leads); a picked Bot is dropped, a seventh pick is ignored.
 */
export function togglePick(selected: readonly string[], botId: string, max = MAX_BOTS_PER_CONVERSATION): string[] {
  if (selected.includes(botId)) return selected.filter((id) => id !== botId);
  return selected.length >= max ? [...selected] : [...selected, botId];
}

/** 1-based pick number (the row's numbered badge), null when not picked. */
export function pickNumber(selected: readonly string[], botId: string): number | null {
  const index = selected.indexOf(botId);
  return index < 0 ? null : index + 1;
}

/** The lead of the group being made: whoever was picked first. */
export function pickedLead(selected: readonly string[]): string | null {
  return selected[0] ?? null;
}

export function groupCanCreate(selected: readonly string[]): boolean {
  return selected.length >= GROUP_MIN_BOTS && selected.length <= MAX_BOTS_PER_CONVERSATION;
}

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

/**
 * Who can be removed (the web's info panel): in a group, anyone but the lead
 * while more than two remain; in a DM, a guest — never the owner.
 */
export function memberRemovable(
  conversation: Pick<BotConversationDetail, 'kind' | 'members' | 'lead_bot_id'>,
  member: BotMemberView,
): boolean {
  if (conversation.kind === 'group') {
    return conversation.members.length > GROUP_MIN_BOTS && member.bot_id !== conversation.lead_bot_id;
  }
  return member.role === 'guest';
}

export function canInviteMore(conversation: Pick<BotConversationDetail, 'members'>): boolean {
  return conversation.members.length < MAX_BOTS_PER_CONVERSATION;
}

/** Active Bots not in the conversation yet, in directory order. */
export function inviteCandidates(
  bots: readonly BotView[],
  conversation: Pick<BotConversationDetail, 'members'>,
): BotView[] {
  const here = new Set(conversation.members.map((member) => member.bot_id));
  return bots.filter((bot) => bot.status === 'active' && !here.has(bot.id));
}

/** A group's possible leads: its active members, in seat order. */
export function leadChoices(
  conversation: Pick<BotConversationDetail, 'members'>,
  byId: Readonly<Record<string, BotView>>,
): BotView[] {
  return sortedMembers(conversation.members).flatMap((member) => {
    const bot = byId[member.bot_id];
    return bot && bot.status === 'active' ? [bot] : [];
  });
}

// ─── Optimistic edits (the server's answer replaces them) ─

/** A new lead, roles kept in step the way the server does: exactly the lead holds `lead`. */
export function withLead(detail: BotConversationDetail, botId: string): BotConversationDetail {
  return {
    ...detail,
    lead_bot_id: botId,
    members: detail.members.map((member) => {
      const role: BotMemberRole = member.bot_id === botId ? 'lead' : member.role === 'lead' ? 'member' : member.role;
      return role === member.role ? member : { ...member, role };
    }),
  };
}

/** A member gone (the server picks a group's next lead itself; its answer brings that in). */
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
