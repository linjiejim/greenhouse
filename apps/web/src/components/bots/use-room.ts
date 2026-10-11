/**
 * A room as the member sees it (spec 20261011-agent-first-class P5): its people, a card for every
 * Agent in it, which of those the member may @, and what they may take out — for the page, its
 * header, the composer, the transcript and the info panel.
 *
 * Agent cards: the member's own and the public Agents they talk to come from the directory; a
 * public Agent offered to them that they never talked to comes from `GET /api/agents` (read once,
 * when a room names one); another person's own Agent is never visible to the member, so its owner's
 * name stands in for it ("Ana's Agent", `roomAgentStandIn`).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BotConversationSummary, BotMemberView, BotView, RoomParticipantView } from '@greenhouse/types/bots';
import { listPublicAgents } from '../../lib/api/bots';
import { useT } from '../../lib/i18n';
import { useAuthStore } from '../../stores';
import { sharedBotAsView } from './bots-store';
import { canRemoveRoomAgent, isPrivateChat, roomAgentStandIn, roomOthers, roomOwnerId } from './room';

export interface RoomAgent {
  member: BotMemberView;
  bot: BotView;
  /** The member's own Agent. */
  mine: boolean;
  /** The member may @ it (their own, or a public one offered to them) — only those answer them. */
  addressable: boolean;
  /** The member may take it out (theirs, or they own the room). */
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

// Public Agents offered to the member they have no conversation with: read once per page load,
// when a room names one the directory lacks (ids are global, faces are what their audience sees).
const publicFaces = new Map<string, BotView>();
const publicAsked = new Set<string>();

export function useRoomView(
  conversation: BotConversationSummary | null | undefined,
  directory: ReadonlyMap<string, BotView>,
): RoomView | null {
  const t = useT();
  const me = useAuthStore((state) => state.currentUser?.id ?? null);
  const [facesVersion, setFacesVersion] = useState(0);
  const room = conversation?.kind === 'room' ? conversation : null;

  const missing = (room?.members ?? [])
    .filter(
      (member) =>
        member.addressable &&
        member.owner_user_id !== me &&
        !directory.has(member.bot_id) &&
        !publicFaces.has(member.bot_id) &&
        !publicAsked.has(member.bot_id),
    )
    .map((member) => member.bot_id)
    .join(',');
  useEffect(() => {
    if (!missing) return;
    let live = true;
    for (const id of missing.split(',')) publicAsked.add(id);
    listPublicAgents()
      .then((agents) => {
        for (const agent of agents) publicFaces.set(agent.id, sharedBotAsView(agent));
        if (live) setFacesVersion((version) => version + 1);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [missing]);

  const formerMember = t('bots.room.formerMember');
  const personName = useCallback(
    (userId: string | null | undefined) =>
      room?.participants?.find((person) => person.user_id === userId)?.nickname ?? formerMember,
    [formerMember, room?.participants],
  );

  return useMemo(() => {
    if (!room) return null;
    void facesVersion;
    const participants = room.participants ?? [];
    const ownerId = roomOwnerId(room);
    const faces = new Map<string, BotView>();
    const agents = room.members
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((member): RoomAgent => {
        const mine = !!me && member.owner_user_id === me;
        const bot =
          directory.get(member.bot_id) ??
          publicFaces.get(member.bot_id) ??
          roomAgentStandIn(member, t('bots.room.agentOf', { name: personName(member.owner_user_id) }));
        faces.set(member.bot_id, bot);
        return {
          member,
          bot,
          mine,
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
  }, [directory, facesVersion, me, personName, room, t]);
}
