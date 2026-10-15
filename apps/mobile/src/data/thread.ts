/**
 * A conversation's transcript as the app holds it, and the rules that read it. React-free
 * (./thread.test.ts).
 *
 * - Messages are kept oldest first by `seq` (the API pages newest first); pages, realtime
 *   events and catch-ups merge by id, so a message is never shown twice and a newer copy wins.
 *   Realtime copies carry no `my_rating`: the one already known is kept.
 * - Only my latest exchange can be edited or regenerated (the server checks it too): my last
 *   message, when nobody spoke after it; and the reply after it, once settled.
 * - Rows show their author only when it changes, or after five quiet minutes.
 */

import type { Message, MessageItem, NeedsYou } from '../shared/contract';
import { parseMs } from './time';

/** One page or event's worth of messages into the transcript (by id; oldest first). */
export function mergeMessages(
  list: readonly MessageItem[],
  incoming: readonly (Message | MessageItem)[],
): MessageItem[] {
  if (!incoming.length) return list as MessageItem[];
  const byId = new Map(list.map((message) => [message.id, message]));
  for (const message of incoming) {
    const known = byId.get(message.id);
    const rating = 'my_rating' in message ? message.my_rating : (known?.my_rating ?? null);
    // A slow page must not rewind a completed reply or a consumed interjection.
    if (known && known.status !== 'streaming' && message.status === 'streaming') continue;
    const event =
      known?.event?.type === 'interjection' &&
      known.event.state !== 'queued' &&
      (!message.event || message.event.state === 'queued')
        ? known.event
        : message.event;
    byId.set(message.id, { ...message, event, my_rating: rating });
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

export function removeMessages(list: readonly MessageItem[], ids: readonly string[]): MessageItem[] {
  if (!ids.length) return list as MessageItem[];
  const gone = new Set(ids);
  return list.filter((message) => !gone.has(message.id));
}

export function patchMessage(list: readonly MessageItem[], id: string, changes: Partial<MessageItem>): MessageItem[] {
  return list.map((message) => (message.id === id ? { ...message, ...changes } : message));
}

/** The highest sequence number known (0 for none): what a catch-up asks `after`. */
export function lastSeq(list: readonly MessageItem[]): number {
  return list.length ? list[list.length - 1]!.seq : 0;
}

/** My last message, if nobody has spoken since (only replies and event lines after it). */
export function editableId(list: readonly MessageItem[], meId: string): string | null {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index]!;
    if (message.role !== 'user') continue;
    return message.author_member_id === meId ? message.id : null;
  }
  return null;
}

/** The settled reply right after my last message (what regenerate writes again). */
export function regenerableId(list: readonly MessageItem[], meId: string): string | null {
  if (!editableId(list, meId)) return null;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index]!;
    if (message.role === 'event') continue;
    return message.role === 'assistant' && message.status !== 'streaming' ? message.id : null;
  }
  return null;
}

/** Who wrote a message, as far as grouping rows goes. */
export function authorKey(message: Pick<Message, 'role' | 'agent_id' | 'author_member_id'>): string {
  if (message.role === 'event') return 'event';
  return message.agent_id ? `agent:${message.agent_id}` : `member:${message.author_member_id ?? ''}`;
}

const GROUP_GAP_MS = 5 * 60_000;

/** Does this message start a new run of rows by one author (so its author line shows)? */
export function startsGroup(message: MessageItem, previous: MessageItem | undefined): boolean {
  if (!previous) return true;
  if (authorKey(previous) !== authorKey(message)) return true;
  const gap = (parseMs(message.created_at) || 0) - (parseMs(previous.created_at) || 0);
  return gap > GROUP_GAP_MS;
}

/** Cards of this conversation keyed by the run they belong to, and those to show at the end. */
export function placeRequests(
  requests: readonly NeedsYou[],
  messages: readonly MessageItem[],
): { byRun: Map<string, NeedsYou[]>; loose: NeedsYou[] } {
  const shownRuns = new Set(messages.filter((message) => message.role === 'assistant').map((m) => m.run_id));
  const byRun = new Map<string, NeedsYou[]>();
  const loose: NeedsYou[] = [];
  for (const request of requests) {
    if (request.run_id && shownRuns.has(request.run_id)) {
      byRun.set(request.run_id, [...(byRun.get(request.run_id) ?? []), request]);
    } else if (request.status === 'pending') {
      loose.push(request);
    }
  }
  return { byRun, loose };
}

/** The newer copy of a card wins; a decided card never goes back to pending. */
export function mergeRequests(list: readonly NeedsYou[], incoming: readonly NeedsYou[]): NeedsYou[] {
  const byId = new Map(list.map((request) => [request.id, request]));
  for (const request of incoming) {
    const known = byId.get(request.id);
    if (known && known.status !== 'pending' && request.status === 'pending') continue;
    byId.set(request.id, request);
  }
  return [...byId.values()].sort((a, b) => (parseMs(a.created_at) || 0) - (parseMs(b.created_at) || 0));
}
