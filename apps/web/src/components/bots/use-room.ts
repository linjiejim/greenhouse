/**
 * A room as the member sees it (spec 20261011-agent-first-class P5): its people, a card for every
 * Agent in it, which of those the member may @, and what they may take out — for the page, its
 * header, the composer, the transcript and the info panel.
 *
 * Agent cards (`roomAgentCard`): the member's own from their directory; anyone else's from the
 * room's `profile` (the server shows each reader every Agent in it — a public one as its published
 * version). Only an older server, which sends no profile, leaves one undescribed: the directory's
 * copy if any, else its owner's name stands in ("Ana's Agent", `roomAgentStandIn`; "Public Agent"
 * when its owner is not in the room).
 */

import { useCallback, useMemo } from 'react';
import type { BotConversationSummary, BotMemberView, BotView, RoomParticipantView } from '@greenhouse/types/bots';
import { useT } from '../../lib/i18n';
import { useAuthStore } from '../../stores';
import { canRemoveRoomAgent, isPrivateChat, roomAgentCard, roomAgentStandIn, roomOthers, roomOwnerId } from './room';

export interface RoomAgent {
  member: BotMemberView;
  bot: BotView;
  /** The member's own Agent. */
  mine: boolean;
  /**
   * Whose it is, as a row says it: "Yours", "Ben's" (its owner is in the room), or "Public Agent"
   * (someone else's shared Agent whose owner is not here).
   */
  byline: string;
  /** The member may address its own, public or restricted room face. */
  addressable: boolean;
  /** The member may take it out (they brought it, it is theirs, or they own the room). */
  removable: boolean;
}

export interface RoomView {
  me: string | null;
  ownerId: string | null;
  isOwner: boolean;
  participants: RoomParticipantView[];
  others: RoomParticipantView[];
  /** Two people, no title, no Agents. */
  privateChat: boolean;
  /** Every Agent here, by position. */
  agents: RoomAgent[];
  /** The `@` list: the Agents the member may address. */
  addressable: BotView[];
  /** A card for every Agent in the room, by id (on top of the member's directory). */
  faces: ReadonlyMap<string, BotView>;
  /** A person's name; someone no longer here reads as "Someone who left". */
  personName: (userId: string | null | undefined) => string;
}

export function useRoomView(
  conversation: BotConversationSummary | null | undefined,
  directory: ReadonlyMap<string, BotView>,
): RoomView | null {
  const t = useT();
  const me = useAuthStore((state) => state.currentUser?.id ?? null);
  const room = conversation?.kind === 'room' ? conversation : null;

  const formerMember = t('bots.room.formerMember');
  const personName = useCallback(
    (userId: string | null | undefined) =>
      room?.participants?.find((person) => person.user_id === userId)?.nickname ?? formerMember,
    [formerMember, room?.participants],
  );

  return useMemo(() => {
    if (!room) return null;
    const participants = room.participants ?? [];
    const ownerId = roomOwnerId(room);
    const faces = new Map<string, BotView>();
    const agents = room.members
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((member): RoomAgent => {
        const mine = !!me && member.owner_user_id === me;
        const owner = participants.find((person) => person.user_id === member.owner_user_id)?.nickname ?? null;
        const bot =
          roomAgentCard(member, me, directory) ??
          roomAgentStandIn(member, owner ? t('bots.room.agentOf', { name: owner }) : t('bots.room.publicAgent'));
        faces.set(member.bot_id, bot);
        return {
          member,
          bot,
          mine,
          byline: mine
            ? t('bots.room.yours')
            : owner
              ? t('bots.room.ownedBy', { name: owner })
              : t('bots.room.publicAgent'),
          addressable: member.addressable === true,
          removable: canRemoveRoomAgent(member, me, ownerId),
        };
      });
    return {
      me,
      ownerId,
      isOwner: !!me && ownerId === me,
      participants,
      others: roomOthers(room, me),
      privateChat: isPrivateChat(room),
      agents,
      addressable: agents.filter((agent) => agent.addressable).map((agent) => agent.bot),
      faces,
      personName,
    };
  }, [directory, me, personName, room, t]);
}
