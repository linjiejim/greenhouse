/**
 * A card's cover: the first image among a record's attachment files (kanban
 * `coverFieldId`, gallery `coverFieldId`).
 *
 * Attachment values are Drive file ids only, so the type is read from the
 * existing authenticated content route (`/api/drive/files/:id/content`, the
 * same check Drive downloads go through): a non-image is abandoned after its
 * headers, the first raster image becomes a blob: URL that is revoked on
 * unmount. Only the preview allowlist is shown (no SVG), like chat attachments.
 */

import { useEffect, useState } from 'react';
import { isSafeAttachmentPreview } from '../../../components/blocks/attachments-block';
import { Image as ImageIcon } from '../../../lib/icons';
import { authFetch } from '../../../lib/auth';

/** Look at most this many files for an image — a record with 40 PDFs is not worth 40 requests. */
const MAX_PROBED_FILES = 4;
const CACHE_LIMIT = 80;

/** content URL → its bytes when it is an image, null when it is not (or failed). */
const probes = new Map<string, Promise<Blob | null>>();

/** The Tables route for a file's bytes; a host whose viewers read files elsewhere passes its own (an app). */
const driveContentUrl = (fileId: number) => `/api/drive/files/${fileId}/content`;

function probeImage(url: string): Promise<Blob | null> {
  const cached = probes.get(url);
  if (cached) return cached;
  const probe = authFetch(url)
    .then(async (response) => {
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok || !isSafeAttachmentPreview('image', type)) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      return response.blob();
    })
    .catch(() => null);
  probes.set(url, probe);
  if (probes.size > CACHE_LIMIT) {
    const oldest = probes.keys().next().value;
    if (oldest !== undefined) probes.delete(oldest);
  }
  return probe;
}

/** Test hook: forget every probed file. */
export function resetRecordCoverCacheForTest(): void {
  probes.clear();
}

export function attachmentIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter((id) => Number.isInteger(id) && id > 0);
}

/** blob: URL of the first image among `fileIds`; `done` once every candidate was looked at. */
function useFirstImage(
  fileIds: readonly number[],
  contentUrl: (fileId: number) => string,
): { url: string | null; done: boolean } {
  // Keyed by the URLs, not the ids: the same file read through another route is another answer.
  const key = fileIds
    .slice(0, MAX_PROBED_FILES)
    .map((id) => contentUrl(id))
    .join('\n');
  const [state, setState] = useState<{ key: string; url: string | null; done: boolean }>({
    key: '',
    url: null,
    done: false,
  });

  useEffect(() => {
    if (!key) return;
    let alive = true;
    let objectUrl: string | null = null;
    void (async () => {
      for (const url of key.split('\n')) {
        const blob = await probeImage(url);
        if (!alive) return;
        if (blob) {
          objectUrl = URL.createObjectURL(blob);
          setState({ key, url: objectUrl, done: true });
          return;
        }
      }
      if (alive) setState({ key, url: null, done: true });
    })();
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [key]);

  if (!key) return { url: null, done: true };
  return state.key === key ? { url: state.url, done: state.done } : { url: null, done: false };
}

interface RecordCoverProps {
  /** The attachment field's value. */
  value: unknown;
  alt: string;
  fit?: 'cover' | 'contain';
  /** Keep the slot (a placeholder) when there is no image — galleries line up; kanban cards collapse. */
  placeholder?: boolean;
  className?: string;
  /** Where a file's bytes are read (`TableViewHost.fileUrl` bound to the record and field). Default: Drive. */
  contentUrl?: (fileId: number) => string;
}

export function RecordCover({
  value,
  alt,
  fit = 'cover',
  placeholder = false,
  className = '',
  contentUrl = driveContentUrl,
}: RecordCoverProps) {
  const { url, done } = useFirstImage(attachmentIds(value), contentUrl);
  if (url) {
    return (
      <img
        src={url}
        alt={alt}
        draggable={false}
        className={`w-full bg-surface-sunken ${fit === 'contain' ? 'object-contain' : 'object-cover'} ${className}`}
        data-testid="record-cover"
      />
    );
  }
  if (!placeholder) return null;
  return (
    <div
      className={`flex w-full items-center justify-center bg-surface-sunken text-fg-faint ${done ? '' : 'animate-pulse'} ${className}`}
      aria-hidden="true"
      data-testid="record-cover-placeholder"
    >
      <ImageIcon size={20} />
    </div>
  );
}
