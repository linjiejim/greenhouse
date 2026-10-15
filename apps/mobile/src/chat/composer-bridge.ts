/**
 * Composer bridge — the result channel from sheets back to the conversation's composer (sheets
 * are routes, so results travel through a store, never callbacks):
 *
 *  - `quoteInComposer(text)`: a source's 「就此追问」 quotes it in the composer (one quote per
 *    message: a new one replaces the last);
 *  - `fillComposer(text)`: an html-preview page's `window.greenhouse.sendPrompt` puts text INTO
 *    the composer, after what is typed — never sent.
 *
 * The conversation on screen drains both; a read-only conversation drops them.
 */

import { create } from 'zustand';
import type { Skill } from '../shared/contract';

interface ComposerBridge {
  skill: Skill | null;
  quote: string | null;
  drafts: string[];
  takeQuote: () => string | null;
  takeDrafts: () => string[];
}

export const useComposerBridge = create<ComposerBridge>((set, get) => ({
  skill: null,
  quote: null,
  drafts: [],
  takeQuote: () => {
    const quote = get().quote;
    if (quote !== null) set({ quote: null });
    return quote;
  },
  takeDrafts: () => {
    const drafts = get().drafts;
    if (drafts.length) set({ drafts: [] });
    return drafts;
  },
}));

/** Quote this in the composer of the conversation on screen. */
export function quoteInComposer(text: string): void {
  useComposerBridge.setState({ quote: text });
}

/** Put this text into the composer of the conversation on screen (appended, never sent). */
export function fillComposer(text: string): void {
  useComposerBridge.setState((s) => ({ drafts: [...s.drafts, text] }));
}
