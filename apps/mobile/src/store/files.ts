/**
 * Files messages carry, by id (Zustand): their names, types and signed URLs (`GET /api/files/:id`).
 * A message only holds file ids; a row asks for the ones it shows (`useFiles`), each fetched once,
 * and again when its URL is about to expire (one to two hours after it was signed).
 *
 * Per identity: emptied when the member or the station changes.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { getFile } from '../api/files';
import { parseMs } from '../data/time';
import type { FileView } from '../shared/contract';
import { useAuth } from './auth';
import { useStations } from './stations';

/** A URL this close to its end is signed again before it is shown. */
const RENEW_MS = 5 * 60_000;

type Entry = FileView | 'missing';

interface FilesState {
  byId: Record<string, Entry>;
  generation: number;
  ensure: (ids: readonly string[]) => void;
  put: (file: FileView) => void;
  reset: () => void;
}

const inFlight = new Set<string>();

const fresh = (entry: Entry | undefined) =>
  !!entry && (entry === 'missing' || (parseMs(entry.expires_at) || 0) - Date.now() > RENEW_MS);

export const useFileStore = create<FilesState>((set, get) => ({
  byId: {},
  generation: 0,

  ensure(ids) {
    const gen = get().generation;
    for (const id of ids) {
      if (fresh(get().byId[id]) || inFlight.has(id)) continue;
      inFlight.add(id);
      void getFile(id).then((result) => {
        inFlight.delete(id);
        if (gen !== get().generation) return;
        // Gone, or not mine to read: show it as unavailable rather than retrying forever.
        if (result.ok || result.status === 404 || result.status === 403) {
          set((state) => ({ byId: { ...state.byId, [id]: result.ok ? result.data : 'missing' } }));
        }
      });
    }
  },

  put(file) {
    set((state) => ({ byId: { ...state.byId, [file.id]: file } }));
  },

  reset() {
    inFlight.clear();
    set({ byId: {}, generation: get().generation + 1 });
  },
}));

/** The files behind these ids, in order (missing ones left out), and whether some are still loading. */
export function useFiles(ids: readonly string[]): { files: FileView[]; loading: boolean } {
  const key = ids.join(',');
  const byId = useFileStore((s) => s.byId);
  useEffect(() => {
    if (key) useFileStore.getState().ensure(key.split(','));
  }, [key]);
  const files: FileView[] = [];
  let loading = false;
  for (const id of ids) {
    const entry = byId[id];
    if (!entry) loading = true;
    else if (entry !== 'missing') files.push(entry);
  }
  return { files, loading };
}

/** Is it a picture the app draws inline? */
export const isImage = (file: Pick<FileView, 'content_type'>) =>
  /^image\/(png|jpe?g|gif|webp|heic|heif|avif|bmp)$/i.test(file.content_type);

// Another member or another station: nothing of the previous one survives.
let identity = '';
const follow = () => {
  const next = `${useStations.getState().activeId ?? ''}:${useAuth.getState().user?.id ?? ''}`;
  if (next === identity) return;
  identity = next;
  useFileStore.getState().reset();
};
useAuth.subscribe(follow);
useStations.subscribe(follow);
