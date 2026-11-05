/**
 * The upload queue: fingerprint → ask the library → (new files only) make previews → upload
 * the original and previews straight to their targets → confirm. Three files move at a time;
 * duplicates never upload a byte, they only add the uploader and fill empty information.
 */
import { create } from 'zustand';
import { api, type UploadFacts } from '../api';
import { derive, type Derived } from '../media/derive';
import { sha256File } from '../media/hash';
import type { FacetValues, LibraryConfig, UploadTarget } from '../types';

export type ItemStatus =
  | 'waiting'
  | 'hashing'
  | 'checking'
  | 'uploading'
  | 'finishing'
  | 'added'
  | 'duplicate'
  | 'binned'
  | 'failed';

export interface BatchInfo {
  title?: string;
  description?: string;
  source?: string;
  tags: string[];
  facets: FacetValues;
  collection_id?: string;
}

export interface QueueItem {
  id: number;
  file: File;
  batch: BatchInfo;
  status: ItemStatus;
  progress: number;
  error?: 'tooLarge' | 'unsupported' | string;
  assetId?: string;
}

interface QueueState {
  items: QueueItem[];
  open: boolean;
  /** Bumped whenever an asset was added, so the library reloads. */
  revision: number;
  add(files: File[], batch: BatchInfo, config: LibraryConfig): void;
  retry(id: number, config: LibraryConfig): void;
  clearFinished(): void;
  setOpen(open: boolean): void;
}

const CONCURRENCY = 3;
let nextId = 0;
let running = 0;

export const ACTIVE: ReadonlySet<ItemStatus> = new Set(['waiting', 'hashing', 'checking', 'uploading', 'finishing']);

export const useQueue = create<QueueState>((set, get) => {
  const patch = (id: number, fields: Partial<QueueItem>) =>
    set((s) => ({ items: s.items.map((item) => (item.id === id ? { ...item, ...fields } : item)) }));

  async function process(item: QueueItem, config: LibraryConfig) {
    const { file } = item;
    const type = file.type || guessType(file.name);
    const kind = config.types.image.includes(type) ? 'image' : config.types.video.includes(type) ? 'video' : null;
    if (!kind) return patch(item.id, { status: 'failed', error: 'unsupported' });
    if (file.size > (kind === 'video' ? config.limits.video_bytes : config.limits.image_bytes))
      return patch(item.id, { status: 'failed', error: 'tooLarge' });
    patch(item.id, { status: 'hashing', progress: 0 });
    const sha256 = await sha256File(file, (fraction) => patch(item.id, { progress: fraction * 0.15 }));
    patch(item.id, { status: 'checking', progress: 0.15 });
    const facts: UploadFacts = {
      sha256,
      size: file.size,
      filename: file.name,
      content_type: type,
      has_preview: false,
      frame_count: 0,
      title: item.batch.title || null,
      description: item.batch.description || null,
      source: item.batch.source || null,
      tags: item.batch.tags,
      facets: item.batch.facets,
      collection_id: item.batch.collection_id || null,
    };
    const [known] = (await api.check([{ sha256, size: file.size }])).results;
    let derived: Derived | undefined;
    if (!known?.exists) {
      derived = await derive(file, kind);
      Object.assign(facts, {
        width: derived.width,
        height: derived.height,
        duration_ms: derived.duration_ms,
        phash: derived.phash,
        has_preview: Boolean(derived.preview),
        frame_count: derived.frames.length,
      });
    }
    const started = await api.startUpload(facts);
    if (started.status !== 'upload') {
      patch(item.id, { status: started.status, progress: 1, assetId: started.asset?.id });
      set((s) => ({ revision: s.revision + 1 }));
      return;
    }
    const { targets } = started;
    // A retried unfinished upload was "known", so nothing was derived yet; its targets still want previews.
    if (!derived && targets.preview) derived = await derive(file, kind);
    const parts: Array<{ target: UploadTarget; body: Blob }> = [{ target: targets.original, body: file }];
    if (derived?.thumb && derived.preview && targets.thumb && targets.preview) {
      parts.push({ target: targets.thumb, body: derived.thumb }, { target: targets.preview, body: derived.preview });
      derived.frames.forEach((frame, i) => targets.frames?.[i] && parts.push({ target: targets.frames[i], body: frame }));
    }
    const total = parts.reduce((sum, p) => sum + p.body.size, 0);
    let sent = 0;
    patch(item.id, { status: 'uploading', progress: 0.2 });
    for (const part of parts) {
      await put(part.target, part.body, (loaded) =>
        patch(item.id, { progress: 0.2 + ((sent + loaded) / total) * 0.75 }),
      );
      sent += part.body.size;
    }
    patch(item.id, { status: 'finishing', progress: 0.97 });
    const done = await api.completeUpload(started.asset.id);
    patch(item.id, { status: 'added', progress: 1, assetId: done.asset.id });
    set((s) => ({ revision: s.revision + 1 }));
  }

  function pump(config: LibraryConfig) {
    while (running < CONCURRENCY) {
      const item = get().items.find((i) => i.status === 'waiting');
      if (!item) return;
      running += 1;
      patch(item.id, { status: 'hashing' });
      process(item, config)
        .catch((error: unknown) =>
          patch(item.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) }),
        )
        .finally(() => {
          running -= 1;
          pump(config);
        });
    }
  }

  return {
    items: [],
    open: false,
    revision: 0,
    add(files, batch, config) {
      const added = files.map((file) => ({ id: ++nextId, file, batch, status: 'waiting' as const, progress: 0 }));
      set((s) => ({ items: [...s.items, ...added], open: true }));
      pump(config);
    },
    retry(id, config) {
      patch(id, { status: 'waiting', progress: 0, error: undefined });
      pump(config);
    },
    clearFinished() {
      set((s) => ({ items: s.items.filter((i) => ACTIVE.has(i.status)) }));
    },
    setOpen(open) {
      set({ open });
    },
  };
});

/** A PUT with upload progress (fetch cannot report it). Ticket URLs need no credentials. */
function put(target: UploadTarget, body: Blob, progress: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(target.method, target.url);
    for (const [name, value] of Object.entries(target.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => progress(event.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload failed (HTTP ${xhr.status})`)));
    xhr.onerror = () => reject(new Error('upload failed (network)'));
    xhr.send(body);
  });
}

const BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

/** Some pickers (HEIC on Windows, files from a folder) leave `type` empty. */
export function guessType(name: string): string {
  return BY_EXTENSION[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''] ?? '';
}
