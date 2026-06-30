/**
 * Knowledge Store (Zustand) — lightweight invalidation signal.
 *
 * The sidebar nav panel loads its doc list once on mount and has no way to know
 * when a doc is created/updated/archived elsewhere. Mutations call `bump()` and
 * the panel re-fetches on the version change.
 */

import { create } from 'zustand';

interface KnowledgeStore {
  /** Bumped whenever knowledge docs change (create/update/archive/restore). */
  version: number;
  /** Signal that the doc list should be re-fetched. */
  bump: () => void;
}

export const useKnowledgeStore = create<KnowledgeStore>((set) => ({
  version: 0,
  bump: () => set((state) => ({ version: state.version + 1 })),
}));
