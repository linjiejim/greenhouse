/**
 * Project detail cache (zustand) — the one place screens and sheets read a
 * project's task tree, members and stats from.
 *
 * Every projects route (detail page, task page, the form / members / peek
 * sheets) is its own screen, so results travel through this store instead of
 * callbacks: a sheet that saves calls `reload(projectId, { fresh: true })`
 * before dismissing and the presenting screen re-renders from the fresh entry
 * (pages also refetch on focus). Status changes are applied optimistically
 * with `patchTask`, then confirmed by a reload. Assignable users are fetched
 * once per account.
 *
 * Ordering rules (why reload is not a plain fetch):
 *  - passive reloads (mount / focus / pull) share an in-flight request,
 *  - a mutation (`patchTask`, or `reload(…, { fresh: true })` after a save)
 *    marks every request already in flight as stale: its response was read
 *    before the write and must not overwrite the optimistic / saved state, so
 *    the next reload starts a new request instead of joining the stale one,
 *  - a response older than one already applied is dropped.
 *
 * The cache belongs to one account on one station: it is cleared whenever
 * the signed-in user or the active station changes (logout, account switch,
 * station switch), and a definitive 403/404 drops the cached copy so a
 * project the user can no longer see disappears instead of lingering.
 */

import { useCallback, useEffect } from 'react';
import { useFocusEffect } from 'expo-router';
import { create } from 'zustand';
import { getProject, listAssignableUsers, type AssignableUser, type ProjectDetail, type ProjectTask } from '../api/projects';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';
import { patchTree } from './meta';

interface ProjectsState {
  details: Record<number, ProjectDetail | undefined>;
  /** Last load for this id failed (missing / no access / offline). */
  failed: Record<number, boolean | undefined>;
  users: AssignableUser[] | null;
  /**
   * Fetch a project. `fresh` = called right after a write: never join a
   * request that was already in flight (it may predate the write).
   */
  reload: (projectId: number, opts?: { fresh?: boolean }) => Promise<ProjectDetail | null>;
  loadUsers: () => Promise<AssignableUser[]>;
  /** Optimistic local patch of one task in a cached tree. */
  patchTask: (projectId: number, taskId: number, patch: Partial<ProjectTask>) => void;
  forget: (projectId: number) => void;
  /** Drop everything (account / station changed). */
  reset: () => void;
}

/** Monotonic request counter (all projects). */
let requestSeq = 0;
/** Bumped by reset(): responses from an older generation are discarded. */
let generation = 0;
const inflight = new Map<number, { seq: number; promise: Promise<ProjectDetail | null> }>();
/** Requests with seq ≤ this started before the latest write — ignore them. */
const staleUpTo = new Map<number, number>();
/** Seq of the last response written to the store. */
const appliedSeq = new Map<number, number>();

function markWrite(projectId: number): void {
  staleUpTo.set(projectId, requestSeq);
}

export const useProjects = create<ProjectsState>((set, get) => ({
  details: {},
  failed: {},
  users: null,

  reload(projectId, opts) {
    if (opts?.fresh) markWrite(projectId);
    const running = inflight.get(projectId);
    if (running && running.seq > (staleUpTo.get(projectId) ?? 0)) return running.promise;

    const seq = ++requestSeq;
    const gen = generation;
    const promise = getProject(projectId)
      .then((res) => {
        const current = get().details[projectId] ?? null;
        if (gen !== generation) return null;
        if (seq <= (staleUpTo.get(projectId) ?? 0) || seq < (appliedSeq.get(projectId) ?? 0)) return current;
        appliedSeq.set(projectId, seq);
        if (res.ok) {
          set((s) => ({
            details: { ...s.details, [projectId]: res.detail },
            failed: { ...s.failed, [projectId]: false },
          }));
          return res.detail;
        }
        set((s) => {
          const details = { ...s.details };
          // gone / no access → forget it; offline → keep showing the last copy
          if (res.definitive) delete details[projectId];
          return { details, failed: { ...s.failed, [projectId]: true } };
        });
        return res.definitive ? null : current;
      })
      .finally(() => {
        if (inflight.get(projectId)?.seq === seq) inflight.delete(projectId);
      });
    inflight.set(projectId, { seq, promise });
    return promise;
  },

  async loadUsers() {
    const cached = get().users;
    // an empty list may be a failed fetch — retry next time
    if (cached?.length) return cached;
    const gen = generation;
    const users = await listAssignableUsers();
    if (gen === generation) set({ users });
    return users;
  },

  patchTask(projectId, taskId, patch) {
    markWrite(projectId);
    set((s) => {
      const detail = s.details[projectId];
      if (!detail) return s;
      return { details: { ...s.details, [projectId]: { ...detail, tasks: patchTree(detail.tasks, taskId, patch) } } };
    });
  },

  forget(projectId) {
    set((s) => {
      const details = { ...s.details };
      delete details[projectId];
      return { details };
    });
  },

  reset() {
    generation++;
    inflight.clear();
    staleUpTo.clear();
    appliedSeq.clear();
    set({ details: {}, failed: {}, users: null });
  },
}));

// The cache is per account per station — clear it when either changes.
useAuth.subscribe((s, prev) => {
  if ((s.user?.id ?? null) !== (prev.user?.id ?? null)) useProjects.getState().reset();
});
useStations.subscribe((s, prev) => {
  if (s.activeId !== prev.activeId) useProjects.getState().reset();
});

/**
 * Subscribe to one project's detail. Loads on mount and — when `refetchOnFocus`
 * (pages) — every time the screen regains focus, e.g. after a sheet saved.
 * `failed` is the last load's outcome; `detail` may still hold the previous
 * copy after a transient (offline) failure.
 */
export function useProjectDetail(
  projectId: number,
  { refetchOnFocus = false }: { refetchOnFocus?: boolean } = {},
): {
  detail: ProjectDetail | undefined;
  failed: boolean;
  /** Pass `{ fresh: true }` after a write (see the ordering rules above). */
  reload: (opts?: { fresh?: boolean }) => Promise<ProjectDetail | null>;
} {
  const detail = useProjects((s) => s.details[projectId]);
  const failed = useProjects((s) => !!s.failed[projectId]);
  const reloadFn = useProjects((s) => s.reload);
  const valid = Number.isFinite(projectId) && projectId > 0;
  const reload = useCallback(
    (opts?: { fresh?: boolean }) => (valid ? reloadFn(projectId, opts) : Promise.resolve(null)),
    [reloadFn, projectId, valid],
  );

  useEffect(() => {
    if (!refetchOnFocus) void reload();
  }, [reload, refetchOnFocus]);

  useFocusEffect(
    useCallback(() => {
      if (refetchOnFocus) void reload();
    }, [reload, refetchOnFocus]),
  );

  return { detail: valid ? detail : undefined, failed: valid ? failed : true, reload };
}

/** Assignable (active internal) users — cached per account. */
export function useAssignableUsers(): AssignableUser[] {
  const users = useProjects((s) => s.users);
  const load = useProjects((s) => s.loadUsers);
  useEffect(() => {
    void load();
  }, [load]);
  return users ?? [];
}
