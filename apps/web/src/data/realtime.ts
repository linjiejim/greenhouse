/**
 * Realtime events into the query cache. Messages and conversation changes are patched in
 * place; everything else marks its queries stale so they refetch when shown.
 */

import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';
import type { Conversation, ConversationDetail, Message, Page, RealtimeEvent } from '@greenhouse/contract';
import { keys } from './query';
import { appendDelta, endStream, upsertStep } from './streams';

export type MessagePages = InfiniteData<Page<Message>, string | undefined>;
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
    return { ...data, pages: [{ ...first!, items: [message, ...first!.items] }, ...rest] };
  });
}

function replaceIn(data: MessagePages, message: Message): MessagePages {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) => (item.id === message.id ? message : item)),
    })),
  };
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
    case 'conversation.updated':
      patchConversation(client, event.data.conversation_id, event.data.changes);
      if ('title' in event.data.changes || 'archived' in event.data.changes) soon(client, keys.conversations);
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
      soon(client, ['notifications']);
      return;
  }
}
