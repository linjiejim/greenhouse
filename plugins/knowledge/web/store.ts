/**
 * Knowledge Store (Zustand) — lightweight invalidation signal.
 *
 * The sidebar nav panel loads its doc list once on mount and has no way to know
 * when a doc is created/updated/archived elsewhere. Mutations call `bump()` and
 * the panel re-fetches on the version change. Changes made elsewhere — another
 * member, a chat tool, an MCP agent — arrive as the `ext.knowledge.changed` WS event
 * and go through `remoteChanged()`, which coalesces a burst into one refetch.
 */

import { create } from 'zustand';

interface KnowledgeStore {
  /** Bumped whenever knowledge docs change (create/update/archive/restore). */
  version: number;
  /** Signal that the doc list should be re-fetched. */
  bump: () => void;
  /** A doc changed somewhere else (WS `ext.knowledge.changed`); bumps once per burst. */
  remoteChanged: () => void;
}

/** Window in which several remote changes (an agent writing a batch) become one refetch. */
export const KNOWLEDGE_REMOTE_COALESCE_MS = 400;
let remoteTimer: ReturnType<typeof setTimeout> | null = null;

export const useKnowledgeStore = create<KnowledgeStore>((set) => ({
  version: 0,
  bump: () => set((state) => ({ version: state.version + 1 })),
  remoteChanged: () => {
    if (remoteTimer) return;
    remoteTimer = setTimeout(() => {
      remoteTimer = null;
      set((state) => ({ version: state.version + 1 }));
    }, KNOWLEDGE_REMOTE_COALESCE_MS);
  },
}));
