/**
 * Global search — whether the palette is open.
 *
 * Only the open flag is global: the nav button, the keyboard shortcut and the
 * palette itself all need it. Query text and results are the palette's own
 * state and die with it, which is what makes each invocation start clean.
 */

import type { SearchKind } from '@greenhouse/types/search';
import { create } from 'zustand';

interface GlobalSearchOpenOptions {
  query?: string;
  kind?: SearchKind | null;
}

interface GlobalSearchState {
  isOpen: boolean;
  initialQuery: string;
  initialKind: SearchKind | null;
  open: (options?: GlobalSearchOpenOptions) => void;
  close: () => void;
  toggle: () => void;
}

export const useGlobalSearchStore = create<GlobalSearchState>((set) => ({
  isOpen: false,
  initialQuery: '',
  initialKind: null,
  open: (options) => set({ isOpen: true, initialQuery: options?.query ?? '', initialKind: options?.kind ?? null }),
  close: () => set({ isOpen: false }),
  toggle: () =>
    set((state) => ({
      isOpen: !state.isOpen,
      ...(!state.isOpen ? { initialQuery: '', initialKind: null } : {}),
    })),
}));
