/**
 * Realtime events into the query cache. Messages and conversation changes are patched in
 * place; everything else marks its queries stale so they refetch when shown. A conversation
 * that missed events (a resync hint, a reconnect) catches up from its last message with
 * `?after=` instead of fetching everything again.
 */

import type { InfiniteData, Query, QueryClient, QueryKey } from '@tanstack/react-query';
import type {
  ComputerView,
  Conversation,
  ConversationDetail,
  ConversationMembers,
  Message,
  MessageItem,
  Page,
  RealtimeEvent,
} from '@greenhouse/contract';
import { api } from '../lib/api';
import { keys } from './query';
import { appendDelta, endStream, forgetStream, upsertStep } from './streams';
import { applyTablesEvent } from './tables';

export type MessagePages = InfiniteData<Page<MessageItem>, string | undefined>;
export type ConversationPages = InfiniteData<Page<Conversation>, string | undefined>;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Catching up reads at most this many pages of 200; further behind, the list is fetched again. */
const CATCH_UP_PAGES = 5;
/** A reconnect also reads back this many of the newest messages: an edit elsewhere changes the latest exchange. */
const RECONNECT_TAIL = 20;

/** Invalidates once for a burst of events. */
function soon(client: QueryClient, queryKey: QueryKey, delay = 300) {
  const id = JSON.stringify(queryKey);
  if (timers.has(id)) return;
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      void client.invalidateQueries({ queryKey });
    }, delay),
  );
}

/** Newest page first, newest message first inside a page (the API's order). */
export function addMessage(client: QueryClient, message: Message) {
  client.setQueryData<MessagePages>(keys.messages(message.conversation_id), (data) => {
    if (!data?.pages.length) return data;
    if (data.pages.some((page) => page.items.some((item) => item.id === message.id))) {
      return replaceIn(data, message);
    }
    const [first, ...rest] = data.pages;
    return { ...data, pages: [{ ...first!, items: [{ ...message, my_rating: null }, ...first!.items] }, ...rest] };
  });
}

/** Realtime messages do not carry the reader's own rating: keep the one we have. */
function replaceIn(data: MessagePages, message: Message): MessagePages {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) =>
        item.id === message.id ? { ...message, my_rating: 'my_rating' in message ? (message as MessageItem).my_rating : item.my_rating } : item,
      ),
    })),
  };
}

export function patchMessage(client: QueryClient, conversationId: string, id: string, changes: Partial<MessageItem>) {
  client.setQueryData<MessagePages>(keys.messages(conversationId), (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) => (item.id === id ? { ...item, ...changes } : item)),
          })),
        }
      : data,
  );
}

export function removeMessage(client: QueryClient, conversationId: string, id: string) {
  client.setQueryData<MessagePages>(keys.messages(conversationId), (data) =>
    data
      ? { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.filter((item) => item.id !== id) })) }
      : data,
  );
}

export function replaceMessage(client: QueryClient, message: Message) {
  client.setQueryData<MessagePages>(keys.messages(message.conversation_id), (data) =>
    data ? replaceIn(data, message) : data,
  );
}

/**
 * Messages from `?after=` into the cache, replacing what it had of them, with the reader's own
 * ratings. A cached message within the range the answer covered (`after` < seq ≤ its last seq)
 * that did not come back was deleted meanwhile; anything newer arrived while it was on its way
 * and stays. A reply already finished here is never taken back to the partial text of the answer.
 */
function mergeMessages(client: QueryClient, conversationId: string, items: MessageItem[], after: number) {
  const upTo = items.at(-1)?.seq ?? after;
  client.setQueryData<MessagePages>(keys.messages(conversationId), (data) => {
    if (!data?.pages.length) return data;
    const fresh = new Map(items.map((item) => [item.id, item]));
    const gone = (item: MessageItem) => item.seq > after && item.seq <= upTo && !fresh.has(item.id);
    const pages = data.pages.map((page) => ({
      ...page,
      items: page.items
        .filter((item) => !gone(item))
        .map((item) => {
          const next = fresh.get(item.id);
          if (!next) return item;
          fresh.delete(item.id);
          return item.status !== 'streaming' && next.status === 'streaming' ? item : next;
        }),
    }));
    const [first, ...rest] = pages;
    return { ...data, pages: [{ ...first!, items: [...fresh.values(), ...first!.items] }, ...rest] };
  });
}

/**
 * A conversation's messages after `afterSeq`, from the API: an event too big to reach this
 * socket's server process, or a reconnect. A list not loaded fetches when it is shown.
 */
export async function catchUp(client: QueryClient, conversationId: string, afterSeq: number): Promise<void> {
  if (!client.getQueryData(keys.messages(conversationId))) return;
  let after = afterSeq;
  for (let page = 0; page < CATCH_UP_PAGES; page++) {
    const { items, next_cursor } = await api.conversations.messages(conversationId, { after, limit: 200 });
    mergeMessages(client, conversationId, items, after);
    // A reply that is done replaces its live piece; one still being written goes on from deltas.
    for (const item of items) if (item.status !== 'streaming') endStream(item.id);
    const last = items.at(-1);
    if (!next_cursor || !last) return;
    after = last.seq;
  }
  await client.invalidateQueries({ queryKey: keys.messages(conversationId) });
}

/**
 * The socket came back. The conversations on screen catch up from just before their newest
 * messages (and the oldest reply that was still being written) and refetch what else is theirs,
 * with the needs-you badge; every other query is only marked stale and refetches when it is next
 * shown. A server restart reconnects every client at once: none of them refetches everything.
 */
export function afterReconnect(client: QueryClient): void {
  const open = client.getQueryCache().findAll({ queryKey: ['messages'], type: 'active' });
  const ids = open.map((query) => String(query.queryKey[1]));
  const badge = JSON.stringify(keys.summary);
  const theirs = (query: Query) =>
    query.queryHash === badge ||
    (query.queryKey[0] !== 'messages' && ids.some((id) => query.queryKey.includes(id)));
  void client.invalidateQueries({ predicate: (query) => !open.includes(query) && !theirs(query), refetchType: 'none' });
  void client.invalidateQueries({ predicate: theirs });
  for (const query of open) {
    const items = (query.state.data as MessagePages | undefined)?.pages.flatMap((page) => page.items) ?? [];
    if (!items.length) continue;
    const newest = Math.max(...items.map((item) => item.seq));
    const writing = items.filter((item) => item.status === 'streaming').map((item) => item.seq);
    const after = Math.max(0, Math.min(newest - RECONNECT_TAIL, ...writing.map((seq) => seq - 1)));
    void catchUp(client, String(query.queryKey[1]), after).catch(() =>
      client.invalidateQueries({ queryKey: query.queryKey }),
    );
  }
}

export function patchConversation(client: QueryClient, id: string, changes: Partial<Conversation>) {
  client.setQueryData<ConversationPages>(keys.conversations, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) => (item.id === id ? { ...item, ...changes } : item)),
          })),
        }
      : data,
  );
  client.setQueryData<ConversationDetail>(keys.conversation(id), (data) => (data ? { ...data, ...changes } : data));
}

export function applyEvent(client: QueryClient, event: Exclude<RealtimeEvent, { type: 'ready' }>) {
  if (applyTablesEvent(client, event)) return;
  switch (event.type) {
    case 'message.created':
      addMessage(client, event.data.message);
      patchConversation(client, event.data.message.conversation_id, {
        last_seq: event.data.message.seq,
        last_activity_at: event.data.message.created_at,
      });
      // Unread counts and order come from the server.
      soon(client, keys.conversations);
      return;
    case 'message.delta':
      appendDelta(event.data.message_id, event.data.text, event.data.offset);
      return;
    case 'message.step':
      upsertStep(event.data.message_id, event.data.step);
      return;
    case 'message.updated':
      replaceMessage(client, event.data.message);
      endStream(event.data.message.id);
      return;
    case 'message.deleted':
      forgetStream(event.data.message_id);
      removeMessage(client, event.data.conversation_id, event.data.message_id);
      return;
    case 'conversation.resync':
      void catchUp(client, event.data.conversation_id, event.data.after_seq).catch(() =>
        soon(client, keys.messages(event.data.conversation_id)),
      );
      // Unread counts and order come from the server.
      soon(client, keys.conversations);
      return;
    case 'conversation.updated':
      // No changes listed: its people or Agents changed (or I left it); refetch it.
      if (!Object.keys(event.data.changes).length) {
        soon(client, keys.conversation(event.data.conversation_id));
        soon(client, keys.members(event.data.conversation_id));
        soon(client, keys.conversations);
        return;
      }
      patchConversation(client, event.data.conversation_id, event.data.changes);
      if ('title' in event.data.changes || 'archived' in event.data.changes) soon(client, keys.conversations);
      return;
    case 'notes.updated':
      soon(client, keys.notes(event.data.conversation_id));
      return;
    case 'read.updated':
      client.setQueryData<ConversationMembers>(keys.members(event.data.conversation_id), (data) =>
        data
          ? {
              ...data,
              members: data.members.map((member) =>
                member.id === event.data.member_id ? { ...member, last_read_seq: event.data.last_read_seq } : member,
              ),
            }
          : data,
      );
      return;
    case 'run.updated':
      soon(client, ['runs']);
      return;
    case 'request.updated':
      soon(client, ['requests']);
      soon(client, keys.summary);
      soon(client, keys.conversations);
      return;
    case 'notification.created':
    case 'notification.read':
      soon(client, ['notifications']);
      return;
    case 'computer.updated':
      // My computer of this Agent started, stopped or failed; its sockets close on their own.
      client.setQueryData<ComputerView>(keys.computer(event.data.agent_id), (data) =>
        data ? { ...data, state: event.data.state } : data,
      );
      soon(client, keys.computer(event.data.agent_id));
      soon(client, ['agents', 'processes', event.data.agent_id]);
      return;
    case 'doc.updated':
      // A doc I have open was saved, renamed, moved, archived or restored. An editing page compares
      // the new version with the one it started from; a draft is never replaced by this.
      soon(client, keys.doc(event.data.doc_id), 100);
      soon(client, keys.docVersions(event.data.doc_id));
      return;
    case 'doc.presence':
      client.setQueryData(keys.docPresence(event.data.doc_id), { items: event.data.items });
      return;
    case 'comments.updated':
      if (event.data.target_type === 'doc') soon(client, keys.docComments(event.data.target_id));
      return;
    case 'knowledge.changed':
      soon(client, keys.knowledge);
      return;
  }
}
