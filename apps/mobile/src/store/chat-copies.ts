/**
 * Copies of the conversations opened last (rules in ../data/chat-copies.ts), per station + member
 * in the documents directory (../data/disk-cache.ts; they go with sign-out and station removal).
 */

import { parseChatCopy, parseChatList, withOpenedChat, type ChatCopy } from '../data/chat-copies';
import { readOffline, removeOffline, writeOffline } from './offline';

const LIST = 'chats-kept';
const kind = (sessionId: string) => `chat-${sessionId}`;

export async function readChatCopy(sessionId: string): Promise<ChatCopy | null> {
  return parseChatCopy(await readOffline(kind(sessionId)));
}

export async function saveChatCopy(sessionId: string, copy: ChatCopy): Promise<void> {
  const { list, dropped } = withOpenedChat(parseChatList(await readOffline(LIST)), sessionId);
  writeOffline(kind(sessionId), copy);
  writeOffline(LIST, list);
  for (const gone of dropped) removeOffline(kind(gone));
}

export async function forgetChatCopy(sessionId: string): Promise<void> {
  removeOffline(kind(sessionId));
  writeOffline(
    LIST,
    parseChatList(await readOffline(LIST)).filter((id) => id !== sessionId),
  );
}
