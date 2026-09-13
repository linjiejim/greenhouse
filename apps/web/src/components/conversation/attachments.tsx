/**
 * Composer attachment state — picking, chips, and upload-on-send.
 *
 * Every conversation can attach any file type now, not just missions
 * (attachment convergence spec): the picking rules and the chip row are the
 * same everywhere, so they live here once and the **uploader is injected**.
 * That is the only part that differs — an ordinary chat uploads to
 * `/api/chat-files` (authenticated, session-scoped row), while the mission
 * preset still stages blobs under its own key prefix until that preset retires.
 *
 * Images are NOT handled here; they keep their own path because `<img src>`
 * cannot send a bearer token (see ChatInput's pendingImages).
 */

import React from 'react';
import { Spinner } from '../ui';
import { FileText, X } from '../../lib/icons';
import { formatFileSize } from '../../lib/file-download';
import { useT } from '../../lib/i18n';

/** Mirrors the server limits in apps/api/src/routes/chat-files.ts. */
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export interface PendingAttachment<Ref> {
  file: File;
  uploading: boolean;
  /** Set once uploaded — a retried send reuses it instead of re-uploading. */
  uploaded?: Ref;
  error?: string;
}

/**
 * Merge newly-picked files into the pending list, enforcing the count cap and
 * per-file size limit. Pure — the caller surfaces the rejections.
 */
export function acceptAttachments<Ref>(
  prev: PendingAttachment<Ref>[],
  incoming: File[],
  limits: { maxCount?: number; maxBytes?: number } = {},
): { next: PendingAttachment<Ref>[]; tooLarge: File[]; overflow: number } {
  const maxCount = limits.maxCount ?? MAX_ATTACHMENTS;
  const maxBytes = limits.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const tooLarge = incoming.filter((f) => f.size > maxBytes);
  const usable = incoming.filter((f) => f.size <= maxBytes);
  const room = Math.max(0, maxCount - prev.length);
  const accepted = usable.slice(0, room);
  return {
    next: accepted.length > 0 ? [...prev, ...accepted.map((file) => ({ file, uploading: false }))] : prev,
    tooLarge,
    overflow: usable.length - accepted.length,
  };
}

/**
 * Upload every not-yet-uploaded chip (in parallel), reflecting per-chip
 * uploading/error state through `setState`. Returns the full ordered ref list,
 * or null when at least one upload failed — failed chips keep their error so
 * the user can retry the send or remove the file.
 */
export async function uploadPendingAttachments<Ref>(
  attachments: PendingAttachment<Ref>[],
  setState: React.Dispatch<React.SetStateAction<PendingAttachment<Ref>[]>>,
  upload: (file: File) => Promise<Ref>,
): Promise<Ref[] | null> {
  const patch = (file: File, update: Partial<PendingAttachment<Ref>>) => {
    setState((prev) => prev.map((a) => (a.file === file ? { ...a, ...update } : a)));
  };
  const results: Array<Ref | null> = await Promise.all(
    attachments.map(async (att) => {
      if (att.uploaded) return att.uploaded;
      patch(att.file, { uploading: true, error: undefined });
      try {
        const uploaded = await upload(att.file);
        patch(att.file, { uploading: false, uploaded });
        return uploaded;
      } catch (err) {
        patch(att.file, { uploading: false, error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    }),
  );
  return results.includes(null) ? null : (results as Ref[]);
}

/** Chip row: file name + size, spinner while uploading, error tone on failure. */
export function AttachmentChips<Ref>({
  attachments,
  onRemove,
  className,
}: {
  attachments: PendingAttachment<Ref>[];
  onRemove: (index: number) => void;
  className?: string;
}) {
  const t = useT();
  if (attachments.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1.5 ${className ?? ''}`}>
      {attachments.map((att, i) => (
        <div
          key={`${att.file.name}-${i}`}
          className={`flex max-w-[240px] items-center gap-1.5 rounded-lg border px-2 py-1 text-xs ${
            att.error ? 'border-danger bg-danger-subtle text-danger' : 'border-edge bg-surface-muted text-fg-secondary'
          }`}
          title={att.error || att.file.name}
        >
          {att.uploading ? (
            <Spinner className="h-3 w-3 flex-shrink-0" />
          ) : (
            <FileText size={12} className={`flex-shrink-0 ${att.error ? 'text-danger' : 'text-fg-muted'}`} />
          )}
          <span className="min-w-0 truncate">{att.file.name}</span>
          <span className={`flex-shrink-0 ${att.error ? 'text-danger' : 'text-fg-faint'}`}>
            {formatFileSize(att.file.size)}
          </span>
          <button
            onClick={() => onRemove(i)}
            disabled={att.uploading}
            className="flex-shrink-0 rounded p-0.5 text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg disabled:opacity-40"
            title={t('common.remove')}
            aria-label={t('common.remove')}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
