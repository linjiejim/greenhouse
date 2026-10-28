/**
 * What the steps sheet (app/sheet/steps.tsx) shows: the tool steps of one reply. The
 * conversation puts them here when the status beside "Sprouty" is tapped, and keeps the live
 * reply's steps current while the sheet is open, so a running step turns done in place.
 */

import { create } from 'zustand';
import type { ToolStep } from './parts';

interface StepsSheet {
  /** The reply the sheet is about (`live` for the reply being written). */
  messageId: string | null;
  steps: ToolStep[];
  /** The tool running now (live reply only). */
  running: string | null;
  show: (messageId: string, steps: ToolStep[], running?: string | null) => void;
  /** The live reply moved on: refresh the sheet if it is showing that reply. */
  follow: (messageId: string, steps: ToolStep[], running: string | null) => void;
}

export const useStepsSheet = create<StepsSheet>((set, get) => ({
  messageId: null,
  steps: [],
  running: null,
  show: (messageId, steps, running = null) => set({ messageId, steps, running }),
  follow: (messageId, steps, running) => {
    if (get().messageId === messageId && (get().steps !== steps || get().running !== running)) set({ steps, running });
  },
}));
