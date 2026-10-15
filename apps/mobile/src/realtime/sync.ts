/**
 * Realtime events into the stores: messages and conversation flags are patched in place, the
 * text of replies being written goes to ../data/streams.ts, and anything else marks what it
 * touches for a refetch — once per burst (`soon`). A `resync` (every `ready`; after a reconnect
 * events may have been missed) refetches the directory and catches every open transcript up.
 * Notifications, runs and computers follow the same socket from their own stores.
 */

import type { ClientEvent } from '../api/realtime';
import { appendDelta, endStream, forgetStream, upsertStep } from '../data/streams';
import { useThreads } from '../store/threads';
import { useWorkspace } from '../store/workspace';

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Runs `fn` once for a burst of calls with the same key. */
export function soon(key: string, fn: () => unknown, delay = 300): void {
  if (timers.has(key)) return;
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      void fn();
    }, delay),
  );
}

const workspace = () => useWorkspace.getState();
const threads = () => useThreads.getState();
const loaded = (id: string | null | undefined): id is string => !!id && !!threads().threads[id];

export function applyEvent(event: ClientEvent): void {
  switch (event.type) {
    case 'resync': {
      void workspace().refresh();
      for (const id of Object.keys(threads().threads)) {
        void threads().catchUp(id);
        void threads().refreshRequests(id);
      }
      return;
    }
    case 'message.created': {
      const { message } = event.data;
      threads().addMessages(message.conversation_id, [message]);
      workspace().patchConversation(message.conversation_id, {
        last_seq: message.seq,
        last_activity_at: message.created_at,
      });
      // Unread counts and the order come from the server.
      soon('conversations', () => workspace().refreshConversations());
      return;
    }
    case 'message.delta':
      appendDelta(event.data.message_id, event.data.text, event.data.offset);
      return;
    case 'message.step':
      upsertStep(event.data.message_id, event.data.step);
      if(event.data.step.tool === 'agent_mutation' && event.data.step.status === 'done') soon('agents',()=>workspace().refreshAgents());
      return;
    case 'message.resumed': {
      const {conversation_id, message_id, offset} = event.data;
      endStream(message_id);
      const message = threads().threads[conversation_id]?.messages.find(item => item.id === message_id);
      if (message?.status === 'streaming') threads().patchMessage(conversation_id, message_id, {content: message.content.slice(0, offset)});
      return;
    }
    case 'message.updated':
      threads().addMessages(event.data.message.conversation_id, [event.data.message]);
      if (event.data.message.steps?.some(step => step.tool === 'agent_mutation' && step.status === 'done') || (event.data.message.event?.type === 'write_receipt' && event.data.message.event.undone === true)) soon('agents',()=>workspace().refreshAgents());
      endStream(event.data.message.id);
      return;
    case 'message.deleted':
      forgetStream(event.data.message_id);
      threads().dropMessages(event.data.conversation_id, [event.data.message_id]);
      return;
    case 'conversation.resync': {
      // An event too big to pass between the server's processes (a long reply's final message):
      // fetch what came after it, as after a reconnect.
      const id = event.data.conversation_id;
      if (loaded(id)) void threads().catchUp(id);
      soon('conversations', () => workspace().refreshConversations());
      return;
    }
    case 'conversation.updated': {
      const { conversation_id: id, changes } = event.data;
      // No changes listed: its people or Agents changed (or I left it): refetch it.
      if (!Object.keys(changes).length) {
        if (loaded(id)) {
          soon(`detail:${id}`, () => threads().refreshDetail(id));
          soon(`members:${id}`, () => threads().refreshMembers(id));
        }
        soon('conversations', () => workspace().refreshConversations());
        return;
      }
      workspace().patchConversation(id, changes);
      if ('title' in changes || 'archived' in changes || 'pinned' in changes) {
        soon('conversations', () => workspace().refreshConversations());
      }
      return;
    }
    case 'read.updated':
      threads().patchMembers(event.data.conversation_id, event.data.member_id, event.data.last_read_seq);
      return;
    case 'request.updated': {
      const id = event.data.conversation_id;
      if (loaded(id)) soon(`requests:${id}`, () => threads().refreshRequests(id));
      soon('summary', () => workspace().refreshSummary());
      soon('conversations', () => workspace().refreshConversations());
      return;
    }
    case 'notification.created':
    case 'notification.read':
      soon('summary', () => workspace().refreshSummary());
      return;
    default:
      return;
  }
}
