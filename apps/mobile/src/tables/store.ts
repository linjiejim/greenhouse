/**
 * Tables cache (zustand) — the one place screens and sheets read Bases, a
 * Base's workspace, a table's schema and the user directory from (the projects
 * store's rules, src/projects/store.ts):
 *
 *  - passive loads (mount / focus / pull) share the request in flight; a load
 *    after a write (`{ fresh: true }`) never joins one that started before it;
 *  - a definitive 403 / 404 drops the cached copy (gone, or no longer shared
 *    with me), a transient failure keeps showing it;
 *  - records are not cached here (each view pages its own); a write bumps
 *    `recordsVersion[tableId]` and every screen showing that table refetches —
 *    that is how a record sheet's save reaches the table page underneath
 *    (results travel through the store, never callbacks);
 *  - the view-options sheet's session overrides (sort / filters / fields /
 *    grouping) live here per view, so the sheet and the page agree;
 *  - the cache belongs to one account on one station: cleared when either changes.
 */

import { useCallback, useEffect } from 'react';
import { useFocusEffect } from 'expo-router';
import { create } from 'zustand';
import {
  getBase,
  getSchema,
  listBases,
  listUsers,
  type Fetch,
  type TableBaseWithRole,
  type TableBaseWorkspace,
  type TableSchema,
  type TableUser,
} from '../api/tables';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';
import type { ViewOverrides } from './model/views';

interface TablesState {
  bases: TableBaseWithRole[] | null;
  basesFailed: boolean;
  workspaces: Record<number, TableBaseWorkspace | undefined>;
  workspaceFailed: Record<number, boolean | undefined>;
  schemas: Record<number, TableSchema | undefined>;
  schemaFailed: Record<number, boolean | undefined>;
  users: TableUser[] | null;
  /** Bumped by every record write on a table; views refetch when it moves. */
  recordsVersion: Record<number, number>;
  /** Session overrides from the view-options sheet, keyed `tableId:viewId`. */
  overrides: Record<string, ViewOverrides | undefined>;

  loadBases: (opts?: { fresh?: boolean }) => Promise<TableBaseWithRole[] | null>;
  loadWorkspace: (baseId: number, opts?: { fresh?: boolean }) => Promise<TableBaseWorkspace | null>;
  loadSchema: (tableId: number, opts?: { fresh?: boolean }) => Promise<TableSchema | null>;
  loadUsers: () => Promise<TableUser[]>;
  recordsChanged: (tableId: number) => void;
  setOverrides: (key: string, overrides: ViewOverrides | undefined) => void;
  reset: () => void;
}

/** Bumped by reset(): responses from an older generation are discarded. */
let generation = 0;

/**
 * One keyed loader: shares the passive request in flight, starts a new one
 * after a write, drops responses older than one already applied.
 */
function keyedLoader<T>() {
  let seq = 0;
  const inflight = new Map<number | string, { seq: number; promise: Promise<T | null> }>();
  const staleUpTo = new Map<number | string, number>();
  const applied = new Map<number | string, number>();
  return {
    load(
      key: number | string,
      fresh: boolean | undefined,
      fetcher: () => Promise<Fetch<T>>,
      apply: (result: Fetch<T>) => T | null,
      current: () => T | null,
    ): Promise<T | null> {
      if (fresh) staleUpTo.set(key, seq);
      const running = inflight.get(key);
      if (running && running.seq > (staleUpTo.get(key) ?? 0)) return running.promise;
      const mine = ++seq;
      const gen = generation;
      const promise = fetcher()
        .then((result) => {
          if (gen !== generation) return null;
          // started before a write (its answer predates it), or older than one already applied
          if (mine <= (staleUpTo.get(key) ?? 0) || mine < (applied.get(key) ?? 0)) return current();
          applied.set(key, mine);
          return apply(result);
        })
        .finally(() => {
          if (inflight.get(key)?.seq === mine) inflight.delete(key);
        });
      inflight.set(key, { seq: mine, promise });
      return promise;
    },
    clear() {
      inflight.clear();
      staleUpTo.clear();
      applied.clear();
    },
  };
}

const basesLoader = keyedLoader<TableBaseWithRole[]>();
const workspaceLoader = keyedLoader<TableBaseWorkspace>();
const schemaLoader = keyedLoader<TableSchema>();
let usersPromise: Promise<TableUser[]> | null = null;

export const useTables = create<TablesState>((set, get) => ({
  bases: null,
  basesFailed: false,
  workspaces: {},
  workspaceFailed: {},
  schemas: {},
  schemaFailed: {},
  users: null,
  recordsVersion: {},
  overrides: {},

  loadBases(opts) {
    return basesLoader.load(
      'all',
      opts?.fresh,
      () => listBases(),
      (result) => {
        if (result.ok) {
          set({ bases: result.value, basesFailed: false });
          return result.value;
        }
        set({ basesFailed: true });
        return get().bases;
      },
      () => get().bases,
    );
  },

  loadWorkspace(baseId, opts) {
    return workspaceLoader.load(
      baseId,
      opts?.fresh,
      () => getBase(baseId),
      (result) => {
        if (result.ok) {
          set((s) => ({
            workspaces: { ...s.workspaces, [baseId]: result.value },
            workspaceFailed: { ...s.workspaceFailed, [baseId]: false },
          }));
          return result.value;
        }
        set((s) => {
          const workspaces = { ...s.workspaces };
          if (result.definitive) delete workspaces[baseId];
          return { workspaces, workspaceFailed: { ...s.workspaceFailed, [baseId]: true } };
        });
        return result.definitive ? null : (get().workspaces[baseId] ?? null);
      },
      () => get().workspaces[baseId] ?? null,
    );
  },

  loadSchema(tableId, opts) {
    return schemaLoader.load(
      tableId,
      opts?.fresh,
      () => getSchema(tableId),
      (result) => {
        if (result.ok) {
          set((s) => ({
            schemas: { ...s.schemas, [tableId]: result.value },
            schemaFailed: { ...s.schemaFailed, [tableId]: false },
          }));
          return result.value;
        }
        set((s) => {
          const schemas = { ...s.schemas };
          if (result.definitive) delete schemas[tableId];
          return { schemas, schemaFailed: { ...s.schemaFailed, [tableId]: true } };
        });
        return result.definitive ? null : (get().schemas[tableId] ?? null);
      },
      () => get().schemas[tableId] ?? null,
    );
  },

  loadUsers() {
    const cached = get().users;
    if (cached?.length) return Promise.resolve(cached);
    if (usersPromise) return usersPromise;
    const gen = generation;
    usersPromise = listUsers()
      .then((result) => {
        const users = result.ok ? result.value : [];
        // an empty list may be a failed fetch — retry next time
        if (gen === generation && users.length) set({ users });
        return users;
      })
      .finally(() => {
        usersPromise = null;
      });
    return usersPromise;
  },

  recordsChanged(tableId) {
    set((s) => ({ recordsVersion: { ...s.recordsVersion, [tableId]: (s.recordsVersion[tableId] ?? 0) + 1 } }));
  },

  setOverrides(key, overrides) {
    set((s) => ({ overrides: { ...s.overrides, [key]: overrides } }));
  },

  reset() {
    generation++;
    basesLoader.clear();
    workspaceLoader.clear();
    schemaLoader.clear();
    usersPromise = null;
    set({
      bases: null,
      basesFailed: false,
      workspaces: {},
      workspaceFailed: {},
      schemas: {},
      schemaFailed: {},
      users: null,
      recordsVersion: {},
      overrides: {},
    });
  },
}));

// The cache is per account per station — clear it when either changes.
useAuth.subscribe((s, prev) => {
  if ((s.user?.id ?? null) !== (prev.user?.id ?? null)) useTables.getState().reset();
});
useStations.subscribe((s, prev) => {
  if (s.activeId !== prev.activeId) useTables.getState().reset();
});

/** The overrides key of a view. */
export function viewKey(tableId: number, viewId: number | null | undefined): string {
  return `${tableId}:${viewId ?? 'none'}`;
}

/** A Base's workspace: loads on mount (pages: and on focus). */
export function useWorkspace(baseId: number, { refetchOnFocus = false } = {}) {
  const workspace = useTables((s) => s.workspaces[baseId]);
  const failed = useTables((s) => !!s.workspaceFailed[baseId]);
  const loadFn = useTables((s) => s.loadWorkspace);
  const valid = Number.isInteger(baseId) && baseId > 0;
  const reload = useCallback(
    (opts?: { fresh?: boolean }) => (valid ? loadFn(baseId, opts) : Promise.resolve(null)),
    [loadFn, baseId, valid],
  );
  useEffect(() => {
    if (!refetchOnFocus) void reload();
  }, [reload, refetchOnFocus]);
  useFocusEffect(
    useCallback(() => {
      if (refetchOnFocus) void reload();
    }, [reload, refetchOnFocus]),
  );
  return { workspace: valid ? workspace : undefined, failed: valid ? failed : true, reload };
}

/** A table's schema (fields + views): loads on mount. */
export function useSchema(tableId: number) {
  const schema = useTables((s) => s.schemas[tableId]);
  const failed = useTables((s) => !!s.schemaFailed[tableId]);
  const loadFn = useTables((s) => s.loadSchema);
  const valid = Number.isInteger(tableId) && tableId > 0;
  const reload = useCallback(
    (opts?: { fresh?: boolean }) => (valid ? loadFn(tableId, opts) : Promise.resolve(null)),
    [loadFn, tableId, valid],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  return { schema: valid ? schema : undefined, failed: valid ? failed : true, reload };
}

/** The internal user directory — loaded once per account; empty until it arrives (or when refused). */
export function useTableUsers(): TableUser[] {
  const users = useTables((s) => s.users);
  const load = useTables((s) => s.loadUsers);
  useEffect(() => {
    void load();
  }, [load]);
  return users ?? [];
}
