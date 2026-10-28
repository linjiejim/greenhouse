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

// saves run one after another, in the order asked: a later copy never lands under an earlier one
let saving: Promise<void> = Promise.resolve();

/** A copy that does not know whose the conversation is keeps what the copy before it knew. */
export function saveChatCopy(sessionId: string, copy: ChatCopy): Promise<void> {
  saving = saving
    .then(async () => {
      const before = copy.shared === undefined ? await readChatCopy(sessionId) : null;
      const { list, dropped } = withOpenedChat(parseChatList(await readOffline(LIST)), sessionId);
      writeOffline(kind(sessionId), before?.shared !== undefined ? { ...copy, shared: before.shared } : copy);
      writeOffline(LIST, list);
      for (const gone of dropped) removeOffline(kind(gone));
    })
    .catch(() => {});
  return saving;
}

export async function forgetChatCopy(sessionId: string): Promise<void> {
  removeOffline(kind(sessionId));
  writeOffline(
    LIST,
    parseChatList(await readOffline(LIST)).filter((id) => id !== sessionId),
  );
}
