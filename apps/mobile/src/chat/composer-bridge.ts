/**
 * Composer bridge — the result channel from peek sheets back to the
 * conversation's composer (sheets are routes, so results travel through a
 * store, never callbacks). A sheet calls `attachToComposer(text)` (e.g. the
 * source peek's "就此提问"); the conversation screen drains `pending` into its
 * composer annotations on focus/next render and clears it.
 */

import { create } from 'zustand';

interface ComposerBridge {
  /** Annotation texts waiting to be attached to the composer. */
  pending: string[];
  take: () => string[];
}

export const useComposerBridge = create<ComposerBridge>((set, get) => ({
  pending: [],
  take: () => {
    const items = get().pending;
    if (items.length) set({ pending: [] });
    return items;
  },
}));

/** Queue an annotation for the conversation composer (callable from any route). */
export function attachToComposer(text: string): void {
  useComposerBridge.setState((s) => ({ pending: [...s.pending, text] }));
}
