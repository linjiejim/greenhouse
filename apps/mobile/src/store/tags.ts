/**
 * Session-tags store (Zustand). Holds the user's tag library + the active
 * history filter. Mutations write through the API and update the cache
 * optimistically-ish (on success), mirroring the web app's manual-refetch
 * model (there is no react-query on either client).
 */

import { create } from 'zustand';
import type { SessionTag } from '../shared/greenhouse-types';
import * as tagsApi from '../api/session-tags';

interface TagsState {
  tags: SessionTag[];
  loaded: boolean;
  /** Active tag filter for the history list (null = all). */
  filterId: number | null;
  load: (force?: boolean) => Promise<void>;
  /** Drop the cache (station switch / re-auth) so the next load refetches. */
  reset: () => void;
  setFilter: (id: number | null) => void;
  create: (name: string, color: string) => Promise<{ ok: boolean; tag?: SessionTag; error?: string }>;
  update: (id: number, patch: { name?: string; color?: string }) => Promise<{ ok: boolean; error?: string }>;
  remove: (id: number) => Promise<boolean>;
}

export const useTags = create<TagsState>((set, get) => ({
  tags: [],
  loaded: false,
  filterId: null,

  async load(force) {
    if (get().loaded && !force) return;
    const tags = await tagsApi.listTags();
    set({ tags, loaded: true });
  },

  reset() {
    set({ tags: [], loaded: false, filterId: null });
  },

  setFilter(filterId) {
    set({ filterId });
  },

  async create(name, color) {
    const r = await tagsApi.createTag(name, color);
    if (r.ok && r.tag) set((s) => ({ tags: [...s.tags, r.tag as SessionTag] }));
    return r;
  },

  async update(id, patch) {
    const r = await tagsApi.updateTag(id, patch);
    if (r.ok && r.tag) set((s) => ({ tags: s.tags.map((t) => (t.id === id ? (r.tag as SessionTag) : t)) }));
    return { ok: r.ok, error: r.error };
  },

  async remove(id) {
    const ok = await tagsApi.deleteTag(id);
    if (ok) set((s) => ({ tags: s.tags.filter((t) => t.id !== id), filterId: s.filterId === id ? null : s.filterId }));
    return ok;
  },
}));
