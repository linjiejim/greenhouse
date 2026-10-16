/**
 * The conversation directory in the drawer (PRD §6.2, docs/design-system/conversation.md),
 * React-free (./directory.test.ts):
 *
 * - The Agent area first, with no heading and never folded: the main Agent on top, then my
 *   other Agents (each opens its Agent thread, made on first use), then other members' public
 *   Agents I already talk to.
 * - Rooms, then chats: pinned, today, and the rest under 「更早」.
 * - A row shows its name and one signal on the right: the needs-you count > muted > running >
 *   unread. Rows never preview messages.
 * - The search narrows every section by name (Agents also by role).
 *
 * The one badge (the bell): how many things need the member, else a dot for anything unread.
 */

import type { Agent, Conversation, PublicAgent } from '../shared/contract';
import { dayKey, parseMs } from './time';
import { matchesDirectory as matches } from './directory-filter';

export interface AgentRow {
  agent: Agent | PublicAgent;
  /** Its Agent thread (the main thread for the main Agent), once there is one. */
  conversation: Conversation | null;
}

export interface DirectorySections {
  main: AgentRow | null;
  agents: AgentRow[];
  /** Other members' public Agents I have an Agent thread with. */
  shared: AgentRow[];
  rooms: Conversation[];
  pinned: Conversation[];
  today: Conversation[];
  earlier: Conversation[];
}

const byActivity = (a: Conversation, b: Conversation) =>
  (parseMs(b.last_activity_at) || 0) - (parseMs(a.last_activity_at) || 0);

export function directorySections(input: {
  agents: readonly Agent[];
  publicAgents: readonly PublicAgent[];
  conversations: readonly Conversation[];
  /** A chat's title when it has none yet. */
  untitled: string;
  mainTitle: string;
  query?: string;
  now: number;
  timeZone?: string;
}): DirectorySections {
  const query = input.query ?? '';
  const live = input.conversations.filter((item) => !item.archived);
  const threads = new Map<string, Conversation>();
  let mainConversation: Conversation | null = null;
  for (const item of live) {
    if (item.kind === 'main') mainConversation = item;
    else if (item.kind === 'direct' && item.agent_id) threads.set(item.agent_id, item);
  }
  const mainAgent = input.agents.find((agent) => agent.is_main) ?? null;
  const mine = new Set(input.agents.map((agent) => agent.id));
  const today = dayKey(input.now, input.timeZone);
  const chats = live.filter((item) => item.kind === 'chat').sort(byActivity);
  const titled = (item: Conversation) => matches(query, item.title || input.untitled);
  return {
    main:
      mainAgent && matches(query, mainAgent.name, input.mainTitle)
        ? { agent: mainAgent, conversation: mainConversation }
        : null,
    agents: input.agents
      .filter((agent) => !agent.is_main && !agent.archived_at && matches(query, agent.name, agent.role))
      .map((agent) => ({ agent, conversation: threads.get(agent.id) ?? null })),
    shared: input.publicAgents
      .filter((agent) => !mine.has(agent.id) && threads.has(agent.id) && matches(query, agent.name, agent.role))
      .map((agent) => ({ agent, conversation: threads.get(agent.id)! })),
    rooms: live.filter((item) => item.kind === 'room' && titled(item)).sort(byActivity),
    pinned: chats.filter((item) => item.pinned && titled(item)),
    today: chats.filter(
      (item) => !item.pinned && titled(item) && dayKey(parseMs(item.last_activity_at) || 0, input.timeZone) === today,
    ),
    earlier: chats.filter(
      (item) => !item.pinned && titled(item) && dayKey(parseMs(item.last_activity_at) || 0, input.timeZone) !== today,
    ),
  };
}

/** The one signal on a row's right, strongest first. */
export type RowSignal =
  | { kind: 'needs'; count: number }
  | { kind: 'muted' }
  | { kind: 'running' }
  | { kind: 'unread' }
  | null;

export function signalOf(conversation: Conversation | null | undefined): RowSignal {
  if (!conversation) return null;
  if (conversation.pending_requests > 0) return { kind: 'needs', count: conversation.pending_requests };
  if (conversation.muted) return { kind: 'muted' };
  if (conversation.working) return { kind: 'running' };
  if (conversation.unread > 0) return { kind: 'unread' };
  return null;
}

/** The plant's face: it moves only while its Agent answers, and waits while it needs you. */
export function moodOf(conversation: Conversation | null | undefined): 'thinking' | 'waiting' | undefined {
  if (conversation?.working) return 'thinking';
  if (conversation?.pending_requests) return 'waiting';
  return undefined;
}

/** The bell's one badge: the needs-you count, else a dot for anything unread, else nothing. */
export type Badge = { kind: 'dot' } | null;

export function badgeOf(summary: { needs_you: number; unread: number } | null | undefined): Badge {
  if (!summary) return null;
  return summary.unread > 0 ? { kind: 'dot' } : null;
}

/** A conversation's fields changed (an event, an optimistic edit): the list with it patched. */
export function patchConversations(
  list: readonly Conversation[],
  id: string,
  changes: Partial<Conversation>,
): Conversation[] {
  return list.map((item) => (item.id === id ? { ...item, ...changes } : item));
}

/** Insert or replace by id (a new or refetched conversation). */
export function upsertConversation(list: readonly Conversation[], conversation: Conversation): Conversation[] {
  const at = list.findIndex((item) => item.id === conversation.id);
  if (at < 0) return [conversation, ...list];
  const next = [...list];
  next[at] = { ...next[at], ...conversation };
  return next;
}
