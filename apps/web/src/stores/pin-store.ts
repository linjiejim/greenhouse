/**
 * Pin Store (Zustand) — manages user-pinned navigation shortcuts.
 *
 * Persists to localStorage. Max 10 pins.
 * Consumed by: PinnedSection, sidebar panels (context menu).
 */

import { create } from 'zustand';
import { getNavModule } from '../lib/nav-registry';

const STORAGE_KEY = 'pinned-nav-items';
const MAX_PINS = 10;

function loadPins(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Filter out invalid IDs (modules that no longer exist in registry)
    return parsed.filter((id: unknown) => typeof id === 'string' && getNavModule(id as string));
  } catch {
    return [];
  }
}

function savePins(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* ignore quota errors */
  }
}

interface PinStore {
  /** Ordered list of pinned module IDs */
  pinnedIds: string[];

  /** Pin a module. Returns false if already at max or invalid ID. */
  pinItem: (id: string) => boolean;

  /** Unpin a module */
  unpinItem: (id: string) => void;

  /** Check if a module is pinned */
  isPinned: (id: string) => boolean;

  /** Replace entire order (after drag-and-drop reorder) */
  reorderPins: (newOrder: string[]) => void;
}

export const usePinStore = create<PinStore>((set, get) => ({
  pinnedIds: loadPins(),

  pinItem: (id: string) => {
    const state = get();
    if (state.pinnedIds.length >= MAX_PINS) return false;
    if (state.pinnedIds.includes(id)) return false;
    if (!getNavModule(id)) return false;
    // Check if pinnable (default true)
    const mod = getNavModule(id)!;
    if (mod.pinnable === false) return false;
    const next = [...state.pinnedIds, id];
    savePins(next);
    set({ pinnedIds: next });
    return true;
  },

  unpinItem: (id: string) => {
    const state = get();
    const next = state.pinnedIds.filter((x) => x !== id);
    savePins(next);
    set({ pinnedIds: next });
  },

  isPinned: (id: string) => {
    return get().pinnedIds.includes(id);
  },

  reorderPins: (newOrder: string[]) => {
    savePins(newOrder);
    set({ pinnedIds: newOrder });
  },
}));
