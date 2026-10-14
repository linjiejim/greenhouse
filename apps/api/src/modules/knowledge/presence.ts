/**
 * Who has a doc open and who is editing it (KNOW-06), in this process's memory: no table. Open
 * pages beat every 20 seconds or so; someone silent for a minute is gone. The guard against
 * losing work is the web's (unsaved changes) and the server's (a stale save is refused); this
 * only tells people about each other.
 */

import type { DocPresence, PresenceState } from '@greenhouse/contract';

export const PRESENCE_TTL_MS = 60_000;

interface Entry {
  name: string;
  state: PresenceState;
  since: number;
  seen: number;
}

export function createPresence(now: () => number = Date.now) {
  const docs = new Map<string, Map<string, Entry>>();

  /** The live entries of a doc; true when someone timed out on the way. */
  function prune(docId: string): { entries: Map<string, Entry> | undefined; pruned: boolean } {
    const entries = docs.get(docId);
    if (!entries) return { entries, pruned: false };
    let pruned = false;
    for (const [memberId, entry] of entries) {
      if (now() - entry.seen > PRESENCE_TTL_MS) {
        entries.delete(memberId);
        pruned = true;
      }
    }
    if (!entries.size) docs.delete(docId);
    return { entries: entries.size ? entries : undefined, pruned };
  }

  function list(docId: string): DocPresence[] {
    const { entries } = prune(docId);
    return [...(entries ?? new Map<string, Entry>())]
      .map(([memberId, entry]) => ({
        member_id: memberId,
        name: entry.name,
        state: entry.state,
        since: new Date(entry.since).toISOString(),
      }))
      .sort((a, b) => a.since.localeCompare(b.since) || a.member_id.localeCompare(b.member_id));
  }

  return {
    list,

    /** Who is there now; `changed` when someone came, left, timed out or switched state. */
    beat(docId: string, member: { id: string; name: string }, state: PresenceState) {
      const { pruned } = prune(docId);
      const entries = docs.get(docId) ?? new Map<string, Entry>();
      docs.set(docId, entries);
      const current = entries.get(member.id);
      const changed = pruned || current?.state !== state;
      entries.set(member.id, {
        name: member.name,
        state,
        since: current && current.state === state ? current.since : now(),
        seen: now(),
      });
      return { items: list(docId), changed };
    },

    /** `left` when they had it open: only then does their leaving change anything. */
    leave(docId: string, memberId: string) {
      const { pruned } = prune(docId);
      const left = docs.get(docId)?.delete(memberId) ?? false;
      return { items: list(docId), changed: pruned || left, left };
    },

    /** The members who have it open, to tell about changes to it. */
    watchers(docId: string): string[] {
      return list(docId).map((entry) => entry.member_id);
    },
  };
}

export type Presence = ReturnType<typeof createPresence>;
