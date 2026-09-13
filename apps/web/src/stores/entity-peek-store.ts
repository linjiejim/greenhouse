/**
 * Entity peek — the stack of records currently open in the detail overlay.
 *
 * "Peek" is the lightweight answer to "show me more about that": a record opens
 * over whatever you were doing instead of navigating you away from it. Chat is
 * the motivating case — following a customer link should not unmount the
 * conversation — but the behaviour is global, so any rendered Markdown gets it.
 *
 * Deliberately not in the URL (spec D11): a peek is a glance, not a destination,
 * so it produces no history entry and survives no refresh. Permanent addresses
 * are what "open full page" is for.
 */

import { create } from 'zustand';
import type { EntityRef } from '@greenhouse/types/entity-links';

export interface PeekEntry {
  ref: EntityRef;
  /**
   * The link text the model wrote, shown in the header until the record loads.
   * Untrusted as data — it is a label, never used to fetch anything.
   */
  label?: string;
}

interface EntityPeekState {
  stack: PeekEntry[];
  /**
   * Open a record, or drill into one from inside an open peek — the same call
   * does both. A click can only come from the front-most surface, so "the peek
   * is already open" is exactly the drill-down case.
   */
  openEntity: (entry: PeekEntry) => void;
  back: () => void;
  close: () => void;
}

function sameRef(a: EntityRef, b: EntityRef): boolean {
  return a.kind === b.kind && JSON.stringify(a) === JSON.stringify(b);
}

export const useEntityPeekStore = create<EntityPeekState>((set) => ({
  stack: [],
  openEntity: (entry) =>
    set((state) => {
      const top = state.stack[state.stack.length - 1];
      // Re-clicking the record already on top would push a duplicate the user
      // then has to press Back through twice to escape.
      if (top && sameRef(top.ref, entry.ref)) return state;
      return { stack: [...state.stack, entry] };
    }),
  back: () => set((state) => ({ stack: state.stack.slice(0, -1) })),
  close: () => set({ stack: [] }),
}));

/** Imperative entry point for non-React callers (the Markdown click delegate). */
export function openEntityPeek(entry: PeekEntry): void {
  useEntityPeekStore.getState().openEntity(entry);
}
