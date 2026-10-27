/**
 * Which conversations keep a copy on the phone: the ones opened last, up to KEPT_CHATS.
 * React-free (./chat-copies.test.ts). A copy is the latest page of messages and the title, saved
 * whenever the station answers, shown at once on open and when the station cannot be reached.
 */

import type { ChatMessage } from '../shared/greenhouse-types';
import type { MessagePage } from './transcript';

export const KEPT_CHATS = 12;

export interface ChatCopy {
  title: string | null;
  page: MessagePage<ChatMessage>;
  /** Whose it is, when known: null mine, else shared with me (by whom). Absent in older copies. */
  shared?: { by: string | null } | null;
}

/** The kept list with this conversation first, and the ones that fell off it. */
export function withOpenedChat(list: readonly string[], sessionId: string): { list: string[]; dropped: string[] } {
  const next = [sessionId, ...list.filter((id) => id !== sessionId)];
  return { list: next.slice(0, KEPT_CHATS), dropped: next.slice(KEPT_CHATS) };
}

export function parseChatList(saved: unknown): string[] {
  return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string').slice(0, KEPT_CHATS) : [];
}

export function parseChatCopy(saved: unknown): ChatCopy | null {
  const value = saved as Partial<ChatCopy> | null;
  const page = value?.page;
  if (!page || !Array.isArray(page.messages)) return null;
  const messages = page.messages.filter(
    (m): m is ChatMessage => !!m && typeof m.id === 'string' && typeof m.seq === 'number' && typeof m.content === 'string',
  );
  return {
    title: typeof value.title === 'string' ? value.title : null,
    ...(value.shared === null
      ? { shared: null }
      : value.shared && typeof value.shared === 'object'
        ? { shared: { by: typeof value.shared.by === 'string' ? value.shared.by : null } }
        : {}),
    page: { messages, has_more: page.has_more === true, next_before_seq: typeof page.next_before_seq === 'number' ? page.next_before_seq : null },
  };
}
