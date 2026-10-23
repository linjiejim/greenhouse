/**
 * Preview of one drive file: images and PDFs in the shared MediaPreviewDialog,
 * plain-text documents in a read-only dialog.
 *
 * Bytes are fetched with the member's token and shown from a blob URL — a plain
 * <img src> carries no Bearer. An image or PDF is only shown when BOTH the file
 * name and the served MIME type agree (the same rule chat attachments use), so
 * a renamed HTML page never renders as a document. Text is rendered as text,
 * never parsed as markup. Anything else simply downloads.
 */

import { useEffect, useState } from 'react';
import { Dialog, Spinner, toast } from '../ui';
import { MediaPreviewDialog } from '../media-preview-dialog';
import { isSafeAttachmentPreview } from '../blocks/attachments-block';
import { fetchAuthenticatedBlob } from '../../lib/file-download';
import { driveFileContentUrl, type DriveFile } from '../../lib/api/drive';
import { useT } from '../../lib/i18n';

export type DrivePreviewKind = 'image' | 'pdf' | 'text';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yaml', 'yml']);
/** Larger text files download instead — a preview is for reading, not for a 50 MB log. */
export const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;

export function drivePreviewKind(file: Pick<DriveFile, 'name' | 'size'>): DrivePreviewKind | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (TEXT_EXT.has(ext) && file.size <= MAX_TEXT_PREVIEW_BYTES) return 'text';
  return null;
}

type Loaded = { kind: 'image' | 'pdf'; url: string; type: string } | { kind: 'text'; text: string };

export function DriveFilePreview({ file, onClose }: { file: DriveFile | null; onClose: () => void }) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    setLoaded(null);
    if (!file) return;
    const kind = drivePreviewKind(file);
    if (!kind) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const blob = await fetchAuthenticatedBlob(driveFileContentUrl(file));
        if (cancelled) return;
        if (kind === 'text') {
          setLoaded({ kind, text: await blob.text() });
          return;
        }
        if (!isSafeAttachmentPreview(kind, blob.type)) throw new Error('unsafe preview');
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ kind, url: objectUrl, type: blob.type });
      } catch {
        if (!cancelled) {
          toast(t('drive.previewFailed'), 'error');
          onClose();
        }
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // onClose is the host's stable close handler; re-running on its identity would refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id]);

  if (!file) return null;

  if (!loaded) {
    return (
      <Dialog open onClose={onClose} title={file.name} size="sm">
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      </Dialog>
    );
  }

  if (loaded.kind === 'text') {
    return (
      <Dialog open onClose={onClose} title={file.name} size="lg">
        <pre
          data-testid="drive-text-preview"
          className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-edge bg-surface-sunken p-3 font-mono text-xs text-fg-secondary"
        >
          {loaded.text}
        </pre>
      </Dialog>
    );
  }

  return (
    <MediaPreviewDialog
      open
      files={[{ src: loaded.url, type: loaded.type, name: file.name }]}
      initialIndex={0}
      onClose={onClose}
    />
  );
}
