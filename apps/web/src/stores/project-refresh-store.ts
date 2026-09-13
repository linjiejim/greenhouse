/**
 * Cross-shell invalidation signal for project collections.
 *
 * The Projects page, its Gantt view, and the persistent sidebar each own a
 * purpose-specific projection. A monotonic revision lets a successful project
 * mutation refresh all three without duplicating their data in another store.
 */

import { create } from 'zustand';

interface ProjectRefreshStore {
  revision: number;
  invalidate: () => void;
}

export const useProjectRefreshStore = create<ProjectRefreshStore>((set) => ({
  revision: 0,
  invalidate: () => set((state) => ({ revision: state.revision + 1 })),
}));

export function invalidateProjects(): void {
  useProjectRefreshStore.getState().invalidate();
}
