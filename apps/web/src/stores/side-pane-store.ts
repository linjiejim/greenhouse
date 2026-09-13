/**
 * Chat side pane — what is open in the right-hand column, and how wide it is.
 *
 * The difference from entity peek (stores/entity-peek-store.ts) is not visual,
 * it is what you can do while it is open. Peek is a modal Drawer: a glance that
 * blocks the conversation behind it. This pane sits in the document flow beside
 * the conversation, so the composer stays live — you can keep talking while
 * looking at, or editing, whatever is on the right.
 *
 * Both are kept. A list page's "show me that record for a second" is still a
 * peek; only Chat, where the point is to work on the thing you are discussing,
 * gets the split (spec D2).
 *
 * Like peek, it is deliberately absent from the URL: closing the tab should not
 * be a way to lose your place, and a pane is not a destination.
 */

import { create } from 'zustand';
import type { EntityRef } from '@greenhouse/types/entity-links';

/**
 * One thing the pane can show.
 *
 * Adding a preview capability is adding a member here plus a branch in
 * `components/side-pane/registry.tsx` — nothing at the call sites changes.
 */
export type SidePaneEntry =
  /** A record, rendered by the same detail components entity peek uses. */
  | { kind: 'entity'; ref: EntityRef; label?: string }
  /**
   * Model-authored self-contained HTML, rendered in a sandboxed iframe.
   *
   * `sourcePath` is the durable identity of what is being shown — the mission
   * artifact's full path (e.g. "reports/deck.html"), which survives a
   * regeneration even though the run id and artifact id do not. It lets the
   * settle handler recognise "the file open in the pane was just rewritten" and
   * swap in the fresh bytes, so editing a deck by chatting updates the preview.
   * Absent for inline ```html-preview fences, which carry their own bytes.
   */
  | { kind: 'html'; code: string; title?: string; sourcePath?: string }
  /** A PDF behind an authenticated download URL. */
  | { kind: 'pdf'; url: string; name: string }
  /** An uploaded/generated image being marked up for a follow-up turn. */
  | { kind: 'image-annotate'; src: string; imageId: string };

export const SIDE_PANE_DEFAULT_WIDTH = 520;
export const SIDE_PANE_MIN_WIDTH = 360;

const WIDTH_KEY = 'chat-side-pane-width';

/**
 * The cap is a fraction rather than a constant: the pane is a companion to the
 * conversation, and letting it take most of a narrow laptop screen makes the
 * composer unusable while pretending to be a feature.
 */
export function maxSidePaneWidth(viewportWidth: number): number {
  return Math.max(SIDE_PANE_MIN_WIDTH, Math.round(viewportWidth * 0.6));
}

function readStoredWidth(): number {
  if (typeof window === 'undefined') return SIDE_PANE_DEFAULT_WIDTH;
  const parsed = Number(localStorage.getItem(WIDTH_KEY));
  if (!Number.isFinite(parsed) || parsed <= 0) return SIDE_PANE_DEFAULT_WIDTH;
  return Math.min(maxSidePaneWidth(window.innerWidth), Math.max(SIDE_PANE_MIN_WIDTH, parsed));
}

interface SidePaneState {
  /** Back-stack, so drilling from one record into another can be undone. */
  stack: SidePaneEntry[];
  /** Whether the retained top entry is currently visible beside the chat. */
  isOpen: boolean;
  /**
   * Showing as a full-screen overlay instead of a column.
   *
   * A report or a prototype outgrows 520px, and dragging the split until the
   * composer is unusable is a worse version of this. Deliberately transient
   * like `isOpen` (D6): it is a way to look at one thing, not a preference.
   */
  isFullscreen: boolean;
  width: number;
  /**
   * Whether a host is currently rendering this pane.
   *
   * Read by the Markdown click delegate to decide between the pane and the peek
   * Drawer. Without it, a CRM link inside the Assistant overlay (which has no
   * pane) would open nothing at all.
   */
  hostMounted: boolean;

  open: (entry: SidePaneEntry) => void;
  back: () => void;
  collapse: () => void;
  reopen: () => void;
  close: () => void;
  setWidth: (width: number) => void;
  setFullscreen: (fullscreen: boolean) => void;
  setHostMounted: (mounted: boolean) => void;
}

function sameEntry(a: SidePaneEntry, b: SidePaneEntry): boolean {
  return a.kind === b.kind && JSON.stringify(a) === JSON.stringify(b);
}

export const useSidePaneStore = create<SidePaneState>((set) => ({
  stack: [],
  isOpen: false,
  isFullscreen: false,
  width: readStoredWidth(),
  hostMounted: false,

  open: (entry) =>
    set((state) => {
      const top = state.stack[state.stack.length - 1];
      // Re-opening what is already on top would push a duplicate the user then
      // has to press Back through twice to escape.
      if (top && sameEntry(top, entry)) return state.isOpen ? state : { isOpen: true };
      // Only records stack. Re-opening a preview replaces it: "look at this
      // other diagram" is a swap, not a drill-down, and a back-stack of HTML
      // previews is just history nobody asked for.
      if (entry.kind !== 'entity') return { stack: [entry], isOpen: true };
      return { stack: [...state.stack, entry], isOpen: true };
    }),
  back: () => set((state) => ({ stack: state.stack.slice(0, -1) })),
  // Collapse keeps the current subject so the TopBar button can restore it.
  // Full screen does not survive it: restoring from the TopBar should give
  // back the column, not silently swallow the conversation again.
  collapse: () => set({ isOpen: false, isFullscreen: false }),
  // The toolbar also opens an empty pane before Chat has supplied content.
  reopen: () => set({ isOpen: true }),
  // Close is the stronger reset used when the conversation context changes.
  close: () => set({ stack: [], isOpen: false, isFullscreen: false }),
  setWidth: (width) => {
    localStorage.setItem(WIDTH_KEY, String(width));
    set({ width });
  },
  setFullscreen: (isFullscreen) => set({ isFullscreen }),
  setHostMounted: (hostMounted) => set({ hostMounted }),
}));

/** Imperative entry point for non-React callers (the Markdown click delegate). */
export function openSidePane(entry: SidePaneEntry): void {
  useSidePaneStore.getState().open(entry);
}

/** True when a host is mounted and can actually show the entry. */
export function isSidePaneAvailable(): boolean {
  return useSidePaneStore.getState().hostMounted;
}
