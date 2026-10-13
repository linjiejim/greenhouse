/**
 * Realtime events into the query cache. Messages and conversation changes are patched in
 * place; everything else marks its queries stale so they refetch when shown.
 */

import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';
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
import { keys } from './query';
import { appendDelta, endStream, forgetStream, upsertStep } from './streams';

export type MessagePages = InfiniteData<Page<MessageItem>, string | undefined>;
export type ConversationPages = InfiniteData<Page<Conversation>, string | undefined>;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

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
  }
}
