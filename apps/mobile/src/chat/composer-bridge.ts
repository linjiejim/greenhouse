/**
 * Composer bridge — the result channel from peek sheets back to the
 * conversation's composer (sheets are routes, so results travel through a
 * store, never callbacks). A sheet calls `attachToComposer(text)` (e.g. the
 * source peek's "就此提问"); the conversation screen drains `pending` into its
 * composer annotations on focus/next render and clears it.
 *
 * A draft can be addressed to one Bots thread (`fillComposer(text, c)` — My
 * Bots' "ask Sprouty to make one", opened while another conversation is still
 * on screen): only that thread takes it (`draftsFor` / `takeDrafts(c)`).
 */

import { create } from 'zustand';

interface Draft {
  text: string;
  /** Only this Bots thread takes it; none = whichever conversation is showing. */
  to?: string;
}

interface ComposerBridge {
  /** Annotation texts waiting to be attached to the composer. */
  pending: string[];
  take: () => string[];
  /** Text waiting to be put INTO the composer (appended to what is typed) — an html-preview's sendPrompt. */
  drafts: Draft[];
  /** The drafts for the conversation `here` (a Bots thread's `c`; none = a chat). */
  takeDrafts: (here?: string) => string[];
}

const forHere = (here: string | undefined) => (draft: Draft) => !draft.to || draft.to === here;

/** Selector: how many drafts wait for the conversation `here`. */
export const draftsFor = (here?: string) => (s: ComposerBridge) => s.drafts.filter(forHere(here)).length;

export const useComposerBridge = create<ComposerBridge>((set, get) => ({
  pending: [],
  take: () => {
    const items = get().pending;
    if (items.length) set({ pending: [] });
    return items;
  },
  drafts: [],
  takeDrafts: (here) => {
    const mine = forHere(here);
    const items = get().drafts;
    const taken = items.filter(mine);
    if (taken.length) set({ drafts: items.filter((draft) => !mine(draft)) });
    return taken.map((draft) => draft.text);
  },
}));

/** Queue an annotation for the conversation composer (callable from any route). */
export function attachToComposer(text: string): void {
  useComposerBridge.setState((s) => ({ pending: [...s.pending, text] }));
}

/**
 * Queue text for the composer itself (not an annotation): an html-preview page's
 * `window.greenhouse.sendPrompt`, or — with `to` — a Bots thread about to open.
 * Appended to what is typed, never sent; a read-only conversation drops it.
 */
export function fillComposer(text: string, to?: string): void {
  useComposerBridge.setState((s) => ({ drafts: [...s.drafts, { text, to }] }));
}
