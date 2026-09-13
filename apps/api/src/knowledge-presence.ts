/**
 * Editing presence for knowledge docs — a lightweight "who's editing this doc"
 * heartbeat. In-memory only (no table, spec M3): the editor page POSTs every 30s
 * and an entry expires after PRESENCE_TTL_MS. This is distinct from the global WS
 * presence (ws/connection-manager.ts, "who is online") — this is per-document.
 *
 * Single-process assumption (the api runs as one process); if the api is ever
 * horizontally scaled this would move to Redis. Kept deliberately trivial.
 */

const PRESENCE_TTL_MS = 90_000; // an editor is "present" for 90s after their last beat

interface Beat {
  nickname: string;
  lastSeen: number;
}

// docId → (userId → beat)
const presence = new Map<number, Map<string, Beat>>();

/** Record/refresh a user's editing heartbeat for a doc. */
export function touchEditingPresence(docId: number, userId: string, nickname: string): void {
  let doc = presence.get(docId);
  if (!doc) {
    doc = new Map();
    presence.set(docId, doc);
  }
  doc.set(userId, { nickname, lastSeen: Date.now() });
}

/** Current (non-expired) editors of a doc. Prunes expired entries as it goes. */
export function listEditingPresence(docId: number): Array<{ userId: string; nickname: string }> {
  const doc = presence.get(docId);
  if (!doc) return [];
  const now = Date.now();
  const live: Array<{ userId: string; nickname: string }> = [];
  for (const [userId, beat] of doc) {
    if (now - beat.lastSeen > PRESENCE_TTL_MS) doc.delete(userId);
    else live.push({ userId, nickname: beat.nickname });
  }
  if (doc.size === 0) presence.delete(docId);
  return live;
}
