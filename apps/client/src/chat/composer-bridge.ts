/**
 * Composer bridge — the result channel from a sheet back to the conversation's composer (sheets
 * are routes, so results travel through a store, never callbacks): an html preview's
 * `window.greenhouse.sendPrompt` puts text INTO the composer, after what is typed — never sent.
 * The conversation on screen drains it.
 */

import { create } from 'zustand';

interface ComposerBridge {
  drafts: string[];
  takeDrafts: () => string[];
}

export const useComposerBridge = create<ComposerBridge>((set, get) => ({
  drafts: [],
  takeDrafts: () => {
    const drafts = get().drafts;
    if (drafts.length) set({ drafts: [] });
    return drafts;
  },
}));

/** Put this text into the composer of the conversation on screen (appended, never sent). */
export function fillComposer(text: string): void {
  useComposerBridge.setState((s) => ({ drafts: [...s.drafts, text] }));
}
