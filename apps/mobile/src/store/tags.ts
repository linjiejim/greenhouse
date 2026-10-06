/**
 * Session-tags store (Zustand). Holds the user's tag library, the active
 * history filter, and the tags assigned to each open conversation.
 * Library mutations write through the API and update the cache on success,
 * mirroring the web app's manual-refetch model (no react-query on either
 * client). Session assignment is optimistic and queued (see
 * `toggleSessionTag`).
 *
 * Tags are per user; the server caps them at 20 per user and 5 per session —
 * the client mirrors both guards so the UI can explain the limit up front.
 * Everything here belongs to one user on one station: the store resets
 * itself whenever the signed-in user or the active station changes (sign-out,
 * signing in as someone else, station switch — subscriptions at the bottom).
 */

import { create } from 'zustand';
import type { SessionTag } from '../shared/greenhouse-types';
import * as tagsApi from '../api/session-tags';
import { useAuth } from './auth';
import { useStations } from './stations';

export type ToggleResult = 'added' | 'removed' | 'limit' | 'failed';

/**
 * Session-assignment writes run one at a time, in tap order, so the server
 * sees the same sequence the optimistic UI shows (and its 5-per-session check
 * never races). Taps are never dropped: each one is applied to the visible set
 * at once and its request queued behind the previous one.
 */
let assignQueue: Promise<unknown> = Promise.resolve();

/** Bumped by reset() so responses for the previous user/station are dropped. */
let generation = 0;

/** Inline (session) copy of a library tag — the shape the session endpoints return. */
function inline(tag: SessionTag): SessionTag {
  return { id: tag.id, name: tag.name, color: tag.color };
}

interface TagsState {
  tags: SessionTag[];
  /** The library holds a server answer (false until the first successful load). */
  loaded: boolean;
  /** The last library load failed (offline / server error); `tags` keeps the previous answer. */
  failed: boolean;
  /** Active tag filter for the history list (null = all). */
  filterId: number | null;
  load: (force?: boolean) => Promise<void>;
  /** Drop every cache (station switch / sign-in / sign-out) so the next load refetches. */
  reset: () => void;
  setFilter: (id: number | null) => void;
  create: (name: string, color: string) => Promise<{ ok: boolean; tag?: SessionTag; error?: string }>;
  update: (id: number, patch: { name?: string; color?: string }) => Promise<{ ok: boolean; error?: string }>;
  remove: (id: number) => Promise<boolean>;
  /**
   * Tags assigned to each open conversation, keyed by session id — the
   * hand-off between the conversation screen (seeds it from getSession and
   * renders the chips) and the /sheets/session-tags sheet (assigns/unassigns
   * and writes the result here), so no callback crosses the route boundary.
   */
  sessionTags: Record<string, SessionTag[]>;
  setSessionTags: (sessionId: string, tags: SessionTag[]) => void;
  /**
   * Attach or detach one tag on a session: applied to `sessionTags` at once,
   * written in tap order, and undone (just that tag) if the request fails.
   * Resolves with what happened so the caller can explain it (`limit` = the
   * session already has the maximum, nothing was sent).
   */
  toggleSessionTag: (sessionId: string, tag: SessionTag) => Promise<ToggleResult>;
}

export const useTags = create<TagsState>((set, get) => ({
  tags: [],
  loaded: false,
  failed: false,
  filterId: null,
  sessionTags: {},

  setSessionTags(sessionId, tags) {
    set((s) => ({ sessionTags: { ...s.sessionTags, [sessionId]: tags } }));
  },

  async toggleSessionTag(sessionId, tag) {
    const current = get().sessionTags[sessionId] ?? [];
    const on = current.some((x) => x.id === tag.id);
    if (!on && current.length >= tagsApi.MAX_TAGS_PER_SESSION) return 'limit';
    get().setSessionTags(sessionId, on ? current.filter((x) => x.id !== tag.id) : [...current, inline(tag)]);

    const gen = generation;
    const write = assignQueue.then(async () =>
      on ? tagsApi.removeTagFromSession(sessionId, tag.id) : (await tagsApi.addTagToSession(sessionId, tag.id)).ok,
    );
    assignQueue = write.catch(() => undefined);
    const ok = await write.catch(() => false);
    if (ok) return on ? 'removed' : 'added';

    // Undo just this tag on the latest set (later taps on other tags stand).
    if (gen === generation) {
      const now = get().sessionTags[sessionId] ?? [];
      const has = now.some((x) => x.id === tag.id);
      if (on && !has) get().setSessionTags(sessionId, [...now, inline(tag)]);
      if (!on && has) get().setSessionTags(sessionId, now.filter((x) => x.id !== tag.id));
    }
    return 'failed';
  },

  async load(force) {
    if (get().loaded && !force) return;
    const gen = generation;
    const tags = await tagsApi.listTags();
    if (gen !== generation) return; // signed out / switched station meanwhile
    if (tags) set({ tags, loaded: true, failed: false });
    else set({ failed: true });
  },

  reset() {
    generation += 1;
    set({ tags: [], loaded: false, failed: false, filterId: null, sessionTags: {} });
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
    if (r.ok && r.tag) {
      const next = r.tag;
      set((s) => ({
        tags: s.tags.map((t) => (t.id === id ? next : t)),
        // keep open conversations' chips in step with the renamed / recolored tag
        sessionTags: mapSessionTags(s.sessionTags, (list) => list.map((t) => (t.id === id ? inline(next) : t))),
      }));
    }
    return { ok: r.ok, error: r.error };
  },

  async remove(id) {
    const ok = await tagsApi.deleteTag(id);
    if (ok) {
      set((s) => ({
        tags: s.tags.filter((t) => t.id !== id),
        filterId: s.filterId === id ? null : s.filterId,
        // the server detaches a deleted tag from every session
        sessionTags: mapSessionTags(s.sessionTags, (list) => list.filter((t) => t.id !== id)),
      }));
    }
    return ok;
  },
}));

// Per account per station — drop the cache when either changes.
useAuth.subscribe((s, prev) => {
  if ((s.user?.id ?? null) !== (prev.user?.id ?? null)) useTags.getState().reset();
});
useStations.subscribe((s, prev) => {
  if (s.activeId !== prev.activeId) useTags.getState().reset();
});

function mapSessionTags(
  all: Record<string, SessionTag[]>,
  fn: (list: SessionTag[]) => SessionTag[],
): Record<string, SessionTag[]> {
  const out: Record<string, SessionTag[]> = {};
  for (const [k, v] of Object.entries(all)) out[k] = fn(v);
  return out;
}
