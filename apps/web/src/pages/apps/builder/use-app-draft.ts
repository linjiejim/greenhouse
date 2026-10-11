/**
 * The builder's draft: load it, edit it locally, save it behind the builder's
 * back (debounced, one save at a time, compare-and-set on `draftRevision`).
 *
 * - A save the validator refuses (400 `spec_invalid`) leaves the server's
 *   draft as it was and shows the problems; the next edit tries again.
 * - A save that lost the race (409 `draft_conflict`: another tab, another
 *   builder, a restore) stops autosaving: the builder reloads the latest draft
 *   — their unsaved edits cannot be merged blindly.
 * - When nothing was edited while a save was in flight, the server's
 *   normalized copy replaces the local one, so what the builder sees is what
 *   publish would publish.
 *
 * `flush()` saves now and resolves whether the draft is saved (publish,
 * preview and restore call it first).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppDraftView, AppSpec, AppSpecError, AppSummary } from '@greenhouse/types/apps';
import { getAppDraft, isRevisionConflict, saveAppDraft, specErrorsOf } from '../../../lib/api/apps-builder';
import { TablesRequestError } from '../../../lib/api/tables';

export type DraftSaveState = 'saved' | 'pending' | 'saving' | 'invalid' | 'conflict' | 'failed';

export type DraftLoad =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'failed' }
  | { kind: 'ready'; app: AppSummary; spec: AppSpec; draftRevision: number };

export const AUTOSAVE_DELAY_MS = 700;

export interface AppDraftController {
  load: DraftLoad;
  errors: AppSpecError[];
  saveState: DraftSaveState;
  /** Change the draft; it is saved shortly after. */
  edit: (change: (spec: AppSpec) => AppSpec) => void;
  /** Save now; true when the draft on the server is the one on screen. */
  flush: () => Promise<boolean>;
  /** Take a draft the server returned (a restore) as the current one. */
  adopt: (view: AppDraftView) => void;
  /** Replace the summary (after a rename, a publish). */
  setApp: (app: AppSummary) => void;
  /** Throw local edits away and read the draft again (after a conflict). */
  reload: () => Promise<void>;
  /** The draft revision the server last confirmed (what publish / restore must name). */
  revision: () => number;
}

export function useAppDraft(appId: number): AppDraftController {
  const [load, setLoad] = useState<DraftLoad>({ kind: 'loading' });
  const [errors, setErrors] = useState<AppSpecError[]>([]);
  const [saveState, setSaveStateValue] = useState<DraftSaveState>('saved');

  const spec = useRef<AppSpec | null>(null);
  const revision = useRef(0);
  /** Bumped by every edit; a save knows whether the draft moved while it ran. */
  const edits = useRef(0);
  const saving = useRef<Promise<void> | null>(null);
  const timer = useRef<number | null>(null);
  const state = useRef<DraftSaveState>('saved');
  const alive = useRef(true);

  const setSaveState = useCallback((next: DraftSaveState) => {
    state.current = next;
    if (alive.current) setSaveStateValue(next);
  }, []);

  const take = useCallback(
    (view: AppDraftView) => {
      spec.current = view.spec;
      revision.current = view.draftRevision;
      setErrors(view.errors);
      setLoad({ kind: 'ready', app: view.app, spec: view.spec, draftRevision: view.draftRevision });
      setSaveState('saved');
    },
    [setSaveState],
  );

  const read = useCallback(async () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    edits.current += 1;
    setLoad({ kind: 'loading' });
    try {
      take(await getAppDraft(appId));
    } catch (error) {
      if (!alive.current) return;
      const missing = error instanceof TablesRequestError && (error.status === 404 || error.status === 403);
      setLoad({ kind: missing ? 'missing' : 'failed' });
    }
  }, [appId, take]);

  useEffect(() => {
    alive.current = true;
    void read();
    return () => {
      alive.current = false;
    };
  }, [read]);

  /** One save loop at a time: it keeps saving while edits arrive during a save. */
  const save = useCallback((): Promise<void> => {
    if (saving.current) return saving.current;
    const run = async () => {
      while (spec.current && (state.current === 'pending' || state.current === 'failed')) {
        const at = edits.current;
        const sent = spec.current;
        setSaveState('saving');
        try {
          const view = await saveAppDraft(appId, sent, revision.current);
          revision.current = view.draftRevision;
          if (alive.current) setErrors(view.errors);
          const untouched = edits.current === at;
          if (untouched) spec.current = view.spec;
          if (alive.current) {
            setLoad((current) =>
              current.kind === 'ready'
                ? {
                    kind: 'ready',
                    app: view.app,
                    spec: untouched ? view.spec : current.spec,
                    draftRevision: view.draftRevision,
                  }
                : current,
            );
          }
          setSaveState(untouched ? 'saved' : 'pending');
        } catch (error) {
          if (isRevisionConflict(error)) {
            setSaveState('conflict');
            return;
          }
          const problems = specErrorsOf(error);
          if (problems) {
            if (alive.current) setErrors(problems);
            // A later edit may fix it: keep going only if one arrived meanwhile.
            setSaveState(edits.current === at ? 'invalid' : 'pending');
            if (edits.current === at) return;
            continue;
          }
          setSaveState(edits.current === at ? 'failed' : 'pending');
          if (edits.current === at) return;
        }
      }
    };
    const promise = run().finally(() => {
      saving.current = null;
    });
    saving.current = promise;
    return promise;
  }, [appId, setSaveState]);

  const edit = useCallback(
    (change: (current: AppSpec) => AppSpec) => {
      if (!spec.current || state.current === 'conflict') return;
      const next = change(spec.current);
      if (next === spec.current) return;
      spec.current = next;
      edits.current += 1;
      setLoad((current) => (current.kind === 'ready' ? { ...current, spec: next } : current));
      setSaveState('pending');
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        void save();
      }, AUTOSAVE_DELAY_MS);
    },
    [save, setSaveState],
  );

  const flush = useCallback(async () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    // A save already running may have been overtaken by edits; run until settled.
    while (saving.current) await saving.current;
    if (state.current === 'pending' || state.current === 'failed') await save();
    return state.current === 'saved';
  }, [save]);

  // Leaving the builder saves what is pending (and warns before a reload drops it).
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (state.current === 'pending' || state.current === 'saving') event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
        void save();
      }
    };
  }, [save]);

  const adopt = useCallback((view: AppDraftView) => take(view), [take]);
  const setApp = useCallback(
    (app: AppSummary) => setLoad((current) => (current.kind === 'ready' ? { ...current, app } : current)),
    [],
  );

  const currentRevision = useCallback(() => revision.current, []);

  return { load, errors, saveState, edit, flush, adopt, setApp, reload: read, revision: currentRevision };
}
