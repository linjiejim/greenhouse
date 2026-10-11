/**
 * Rooms on the phone — several people, and the Agents they bring, in one conversation
 * (`bot_conversations.kind = 'room'`; spec docs/specs/20261011-agent-first-class.md §5d, D42–D47;
 * server contract apps/api/src/bots/AGENTS.md「多人对话 room」). A room runs on the thread machinery
 * (./thread/engine.ts, the `/?c=` route); what is the same on every client — what a room is called,
 * who is in it, whose each Agent is — is the web's, vendored (./vendor/room.ts). What only the phone
 * needs lives here, React-free so the root vitest pins it (./rooms.test.ts):
 *
 *  - the drawer row: the preview names who spoke ("You: …", "Ana: …", "Sage: …"), the search text,
 *    the people's initials and the colour each person's initial wears;
 *  - names for Agents the member's directory doesn't know (another person's own Agent is never in
 *    the member's Bot list): a public one offered to the member from "Browse Agents", else its
 *    owner's name stands in ("Ana's Agent") — `roomDirectory`;
 *  - the composer: only Agents the member may address (`addressable`) can be @-mentioned;
 *  - whose live run it is (`roomRunMine`) when the server doesn't say: a run is its asker's and only
 *    they may stop it (see the module's last section);
 *  - the ⋯ menu's Agents (bring one of the member's own, take out one they may) and the
 *    new-conversation sheet's people list and request.
 */

import type { RoomPerson } from '../api/bots';
import type {
  BotConversationSummary,
  BotMemberView,
  BotView,
  RoomParticipantView,
  SharedBotView,
} from '../shared/bots';
import { sharedAsBot } from './public-agents';
import {
  canRemoveRoomAgent,
  isPrivateChat,
  personName,
  roomAgentStandIn,
  roomOthers,
  roomOwnerId,
} from './vendor/room';

export { isPrivateChat, isRoom, personName, roomOthers, roomOwnerId, roomTitle } from './vendor/room';

type Room = Pick<BotConversationSummary, 'kind' | 'title' | 'members' | 'participants'>;

// ─── The drawer row ──────────────────────────────────────

export interface RoomPreviewCopy {
  noMessages: string;
  youSaid(text: string): string;
  /** "{name}: {text}" — a person or an Agent. */
  botSaid(name: string, text: string): string;
}

/**
 * The row's preview of the last message, naming who wrote it: the member ("You: …"), another
 * person by the name the room knows them by, or the Agent (`agentName` — null: unnamed). A line
 * from someone no longer in the room reads bare.
 */
export function roomPreview(
  row: Pick<BotConversationSummary, 'participants' | 'last_message'>,
  viewerId: string | null,
  agentName: (botId: string) => string | null,
  copy: RoomPreviewCopy,
): string {
  const last = row.last_message;
  if (!last) return copy.noMessages;
  const text = last.preview.replace(/\s+/g, ' ').trim();
  if (last.role === 'user') {
    const author = last.author_user_id ?? null;
    if (!author || author === viewerId) return copy.youSaid(text);
    const name = personName(row, author);
    return name ? copy.botSaid(name, text) : text;
  }
  if (last.bot_id) {
    const name = agentName(last.bot_id);
    return name ? copy.botSaid(name, text) : text;
  }
  return text;
}

/** What a drawer search looks at in a room: its title, its people, the last preview. */
export function roomSearchText(row: Pick<BotConversationSummary, 'title' | 'participants' | 'last_message'>): string {
  const people = (row.participants ?? []).map((person) => person.nickname);
  return [row.title ?? '', ...people, row.last_message?.preview ?? ''].join('\n').toLocaleLowerCase();
}

/**
 * The people a room's avatar shows: the other person in a private chat; else the others in the
 * order they joined (the drawer row overlaps the first two). Everyone else gone: the member.
 */
export function roomFaces(
  room: Pick<BotConversationSummary, 'participants'>,
  viewerId: string | null,
): RoomParticipantView[] {
  const others = roomOthers(room, viewerId);
  if (others.length > 0) return others;
  return (room.participants ?? []).filter((person) => person.user_id === viewerId);
}

/** The system colours a person's initial may wear (never the accent — that is the member's own). */
export const PERSON_TINTS = ['blue', 'orange', 'green', 'indigo', 'purple'] as const;
export type PersonTint = (typeof PERSON_TINTS)[number];

/** A person's colour: the same one everywhere they appear (a hash of their id). */
export function personTint(userId: string): PersonTint {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return PERSON_TINTS[hash % PERSON_TINTS.length];
}

// ─── Who the Agents in a room are ────────────────────────

export interface RoomAgentCopy {
  /** "Ana's Agent". */
  agentOf(name: string): string;
  /** An Agent whose owner has left too. */
  someAgent: string;
}

/**
 * The member's directory (`byId`) plus a card for every Agent of the room it doesn't know — its
 * members and the Agents that wrote in it (`speakers`, some gone since): a public Agent offered to
 * the member (`offered`, "Browse Agents") as itself, else a stand-in its owner names ("Ana's
 * Agent", the vendored `roomAgentStandIn`; its plant comes from its id). `guessed` = the stand-ins:
 * they are named after their owner, not themselves — never offered for an @-mention. `byId` itself
 * comes back when nothing is missing.
 */
export function roomDirectory(o: {
  byId: Record<string, BotView>;
  room: Pick<BotConversationSummary, 'members' | 'participants'>;
  offered: readonly SharedBotView[];
  speakers?: readonly string[];
  copy: RoomAgentCopy;
}): { byId: Record<string, BotView>; guessed: ReadonlySet<string> } {
  const guessed = new Set<string>();
  let out = o.byId;
  const add = (bot: BotView) => {
    if (out === o.byId) out = { ...o.byId };
    out[bot.id] = bot;
  };
  const offered = new Map(o.offered.map((view) => [view.id, view]));
  const members = new Map(o.room.members.map((member) => [member.bot_id, member]));
  const ids = new Set([...members.keys(), ...(o.speakers ?? [])]);
  for (const id of ids) {
    if (out[id]) continue;
    const view = offered.get(id);
    if (view) {
      add(sharedAsBot(view));
      continue;
    }
    const member = members.get(id);
    const owner = member?.owner_user_id ? personName(o.room, member.owner_user_id) : null;
    add(
      roomAgentStandIn(
        { bot_id: id, owner_user_id: member?.owner_user_id },
        owner ? o.copy.agentOf(owner) : o.copy.someAgent,
      ),
    );
    guessed.add(id);
  }
  return { byId: out, guessed };
}

/**
 * An Agent the member may address here that no list names yet (a public one offered to them they
 * never talked to): "Browse Agents" (`GET /api/agents`) has it — read it once.
 */
export function needsOffered(
  room: Pick<BotConversationSummary, 'members'>,
  byId: Record<string, BotView>,
  offered: readonly SharedBotView[],
): boolean {
  const known = new Set(offered.map((view) => view.id));
  return room.members.some((member) => member.addressable && !byId[member.bot_id] && !known.has(member.bot_id));
}

/**
 * Who the member can @ in a room, in the room's order: the Agents they may address (their own, or a
 * public one offered to them — `addressable`, the server's answer for this reader) that are still
 * active and known by their own name. Nobody else's Agent: the server would drop that mention.
 */
export function mentionableAgents(
  room: Pick<BotConversationSummary, 'members'>,
  byId: Record<string, BotView>,
  guessed: ReadonlySet<string> = new Set(),
): BotView[] {
  return [...room.members]
    .sort((a, b) => a.position - b.position)
    .flatMap((member) => {
      const bot = byId[member.bot_id];
      return member.addressable && bot && bot.status === 'active' && !guessed.has(bot.id) ? [bot] : [];
    });
}

/**
 * Ids worth learning through the member's Bot list (`ensureBotsKnown`): in a room, never an Agent
 * the room says the member may not address — another person's own Agent is never in their list.
 * Anything else (another kind, an Agent no longer in the room) as given.
 */
export function learnableIds(
  conversation: Pick<BotConversationSummary, 'kind' | 'members'> | null | undefined,
  ids: readonly string[],
): string[] {
  if (conversation?.kind !== 'room') return [...ids];
  const foreign = new Set(conversation.members.filter((m) => m.addressable === false).map((m) => m.bot_id));
  return ids.filter((id) => !foreign.has(id));
}

/** The member's own active Agents not in the room yet — "Bring an Agent". */
export function bringableAgents(room: Pick<BotConversationSummary, 'members'>, own: readonly BotView[]): BotView[] {
  const here = new Set(room.members.map((member) => member.bot_id));
  return own.filter((bot) => bot.status === 'active' && !here.has(bot.id));
}

/** The Agents in the room the member may take out (theirs, or any when the room is theirs) — "Remove an Agent". */
export function removableAgents(
  room: Pick<BotConversationSummary, 'members' | 'participants'>,
  viewerId: string | null,
): BotMemberView[] {
  const owner = roomOwnerId(room);
  return [...room.members]
    .sort((a, b) => a.position - b.position)
    .filter((member) => canRemoveRoomAgent(member, viewerId, owner));
}

/** What the title's status line says about a room at rest: a private chat, else how many people and Agents. */
export function roomStatus(room: Room): { privateChat: boolean; people: number; agents: number } {
  return {
    privateChat: isPrivateChat(room),
    people: room.participants?.length ?? 0,
    agents: room.members.length,
  };
}

/** The member is the last one in: leaving deletes the room. */
export function lastOneIn(room: Pick<BotConversationSummary, 'participants'>, viewerId: string | null): boolean {
  const people = room.participants ?? [];
  return people.length <= 1 && (people.length === 0 || people[0].user_id === viewerId);
}

// ─── Starting one, adding people ─────────────────────────

/**
 * The people list of the new-conversation sheet: those not in the room already (`exclude`), matched
 * against a search by name or email, in the server's order (by name).
 */
export function peopleRows(
  people: readonly RoomPerson[],
  query: string,
  exclude: ReadonlySet<string> = new Set(),
): RoomPerson[] {
  const q = query.trim().toLocaleLowerCase();
  return people.filter(
    (person) =>
      !exclude.has(person.id) &&
      (!q || person.nickname.toLocaleLowerCase().includes(q) || person.email.toLocaleLowerCase().includes(q)),
  );
}

/** `POST /api/rooms`'s body: the picked people, a title only when one was typed, Agents only when picked. */
export function createRoomInput(o: { people: readonly string[]; title: string; agents: readonly string[] }): {
  user_ids: string[];
  title?: string;
  bot_ids?: string[];
} {
  const title = o.title.trim();
  return {
    user_ids: [...new Set(o.people)],
    ...(title ? { title } : {}),
    ...(o.agents.length ? { bot_ids: [...new Set(o.agents)] } : {}),
  };
}

// ─── Whose run it is ─────────────────────────────────────
//
// In a room a run is its asker's: their Agent answers with their access, and only they may stop it
// (the server refuses anyone else's interrupt and stop with a 404). When the run probe
// (`GET /api/chat/runs/:id`) names whose it is (`run.user_id`), the engine takes that outright; the
// `chat:run` push never says, and neither does an older server — then the phone reads it from what it
// does know:
//   1. the Agent speaking first in the run — one the member may not address can't be answering
//      them; one of their own private Agents can only be answering them;
//   2. otherwise (a public Agent, or no one has spoken yet) this device's own ask: a room message
//      it sent with @-mentions, before this run began, that no run has answered since — and, once
//      someone speaks, only if it was one of the Agents that ask named.
// A wrong guess only costs a Stop that does nothing (the server refuses it).

export interface RoomAsk {
  /** When it was sent, in the engine's order of asks and runs: only a run begun after it may answer it. */
  at: number;
  /** The Agents it @-mentioned. */
  bots: ReadonlySet<string>;
}

export function roomRunMine(o: {
  viewerId: string | null;
  members: readonly BotMemberView[];
  /** The first Agent to speak in the run (null: no one yet). */
  firstSpeaker: string | null;
  /** One of the member's own Agents only they may address (not published). */
  ownPrivate: (botId: string) => boolean;
  /** This device's open ask, when it may be this run's (sent before the run began). */
  ask: RoomAsk | null;
}): boolean {
  const speaker = o.firstSpeaker;
  if (!speaker) return o.ask !== null;
  const member = o.members.find((m) => m.bot_id === speaker);
  if (member?.addressable === false) return false;
  if (member && member.owner_user_id === o.viewerId && o.ownPrivate(speaker)) return true;
  return o.ask !== null && o.ask.bots.has(speaker);
}
