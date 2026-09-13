/**
 * AttachmentsBlock — pill chips for the files a user attached to a turn (the
 * ```attachments fence, or its historical ```mission-attachments name).
 *
 * Deliberately lighter than MissionArtifactsBlock's full cards: inputs are
 * context for what the user asked, deliverables are the result. Chips sit
 * inside the user bubble just above its timestamp.
 *
 * Two handle kinds resolve to two authenticated endpoints — a `chat_files`
 * row by id, or a mission staging blob by storage key. Either way a plain
 * <a href> carries no Bearer, so bytes are always fetched, never linked.
 */

import React, { useState } from 'react';
import { Download, FileText, Image as ImageIcon } from '../../lib/icons';
import { Spinner, toast } from '../ui';
import { useT } from '../../lib/i18n';
import { formatFileSize, downloadAuthenticatedFile, fetchAuthenticatedBlob } from '../../lib/file-download';
import { cloudAgentAttachmentDownloadUrl } from '../../lib/api/cloud-agent';
import { chatFileDownloadUrl } from '../../lib/api/chat-files';
import type { ChatAttachmentItem, ChatAttachmentsData } from './index';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']);

function extensionOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * What opens in a tab rather than saving to disk.
 *
 * HTML is intentionally NOT previewable: a blob: URL inherits the creating
 * page's origin, so opening attacker-authored markup would run script against
 * this session. Images and PDFs render in sandboxed browser viewers instead.
 */
function previewKindOf(name: string): 'image' | 'pdf' | null {
  const ext = extensionOf(name);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  return null;
}

const SAFE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']);

export function isSafeAttachmentPreview(kind: 'image' | 'pdf', contentType: string): boolean {
  const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return kind === 'pdf' ? normalized === 'application/pdf' : SAFE_IMAGE_MIME.has(normalized);
}

/** id → chat_files route; key → the mission staging download. */
function downloadUrlOf(item: ChatAttachmentItem): string {
  return item.id ? chatFileDownloadUrl(item.id) : cloudAgentAttachmentDownloadUrl(item.key!);
}

export function AttachmentsBlock({ data }: { data: ChatAttachmentsData }) {
  if (data.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {data.map((item) => (
        <AttachmentPill key={item.id ?? item.key} name={item.name} size={item.size_bytes} url={downloadUrlOf(item)} />
      ))}
    </div>
  );
}

function AttachmentPill({ name, size, url }: { name: string; size?: number; url: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const preview = previewKindOf(name);
  const Icon = preview === 'image' ? ImageIcon : FileText;

  const run = async (action: 'preview' | 'download') => {
    if (busy) return;
    setBusy(true);
    try {
      if (action === 'preview') {
        const blob = await fetchAuthenticatedBlob(url);
        if (!preview || !isSafeAttachmentPreview(preview, blob.type)) {
          throw new Error('Attachment content type is not safe to preview');
        }
        const objectUrl = URL.createObjectURL(blob);
        window.open(objectUrl, '_blank', 'noopener,noreferrer');
        // The tab has its own reference by now; freeing later avoids leaking
        // the blob for the lifetime of the session.
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      } else {
        await downloadAuthenticatedFile(url, name);
      }
    } catch {
      toast(t('cloudAgent.downloadFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex max-w-[260px] items-center gap-1.5 rounded-full border border-primary-edge bg-surface-raised py-1 pl-2.5 pr-1 text-xs text-fg-secondary">
      <button
        type="button"
        onClick={() => void run(preview ? 'preview' : 'download')}
        disabled={busy}
        title={preview ? t('cloudAgent.previewAttachment', { name }) : t('cloudAgent.downloadAttachment', { name })}
        className="flex min-w-0 items-center gap-1.5 rounded-full hover:text-fg disabled:opacity-50"
      >
        {busy ? (
          <Spinner className="h-3 w-3 flex-shrink-0" />
        ) : (
          <Icon size={12} className="flex-shrink-0 text-fg-muted" />
        )}
        <span className="min-w-0 truncate">{name}</span>
        {size != null && <span className="flex-shrink-0 text-fg-faint">{formatFileSize(size)}</span>}
      </button>
      <button
        type="button"
        onClick={() => void run('download')}
        disabled={busy}
        title={t('cloudAgent.downloadAttachment', { name })}
        aria-label={t('cloudAgent.downloadAttachment', { name })}
        className="flex-shrink-0 rounded-full p-1 text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg disabled:opacity-50"
      >
        <Download size={12} />
      </button>
    </span>
  );
}
