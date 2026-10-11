/**
 * Who hears about a Bots conversation (spec 20261011-agent-first-class P5): its one member — or,
 * in a room, every person in it. The pushes carry no content (`bots:conversation` → the client
 * re-reads; `chat:run` → the client may attach to the live run), so fanning them out leaks nothing
 * a participant cannot read anyway.
 *
 * Participants are cached for a few seconds (a busy run pushes often); room routes that change
 * them call `forgetConversationAudience`.
 */

import { getDb, type DatabaseProvider } from '@greenhouse/db';
import type { ServerWsEvent } from '@greenhouse/types/ws';
import { connectionManager } from '../../ws/connection-manager.js';

const TTL_MS = 5_000;
const cache = new Map<string, { ids: string[]; at: number }>();

/** The people a conversation's pushes go to: a room's participants, else its member. */
export async function conversationAudience(
  sessionId: string,
  memberId: string,
  db: DatabaseProvider = getDb(),
): Promise<string[]> {
  const hit = cache.get(sessionId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ids.length > 0 ? hit.ids : [memberId];
  let ids: string[];
  try {
    ids = ((await db.bots.listParticipants([sessionId])).get(sessionId) ?? []).map((p) => p.user_id);
  } catch {
    ids = [];
  }
  cache.set(sessionId, { ids, at: Date.now() });
  if (cache.size > 2_000) cache.delete(cache.keys().next().value!);
  return ids.length > 0 ? ids : [memberId];
}

export function forgetConversationAudience(sessionId: string): void {
  cache.delete(sessionId);
}

/** Push to everyone who reads this conversation. Never throws. */
export async function pushToConversation(
  sessionId: string,
  memberId: string,
  message: ServerWsEvent,
  db?: DatabaseProvider,
): Promise<void> {
  for (const id of await conversationAudience(sessionId, memberId, db)) connectionManager.sendToUser(id, message);
}
