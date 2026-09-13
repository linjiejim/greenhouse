import React, { useState } from 'react';
import { Download, FileDown } from '../../lib/icons';
import { formatFileSize } from '../../lib/file-download';
import { Button, Spinner } from '../ui';

export interface FileAttachmentCardProps {
  name: string;
  size?: number;
  detail?: string;
  href?: string;
  onDownload?: () => Promise<void>;
  downloadLabel?: string;
  downloadError?: () => void;
  /** Optional secondary action, e.g. "preview" for a deliverable the pane can show. */
  secondaryAction?: React.ReactNode;
}

/** Shared file presentation used by persisted content attachments and Chat artifacts. */
export function FileAttachmentCard({
  name,
  size,
  detail,
  href,
  onDownload,
  downloadLabel = 'Download',
  downloadError,
  secondaryAction,
}: FileAttachmentCardProps) {
  const [downloading, setDownloading] = useState(false);
  const meta = [detail, size == null ? undefined : formatFileSize(size)].filter(Boolean).join(' · ');

  const action = onDownload ? (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={downloading}
      onClick={async () => {
        setDownloading(true);
        try {
          await onDownload();
        } catch {
          downloadError?.();
        } finally {
          setDownloading(false);
        }
      }}
    >
      {downloading ? <Spinner className="mr-1.5 h-3.5 w-3.5" /> : <Download size={14} className="mr-1.5" />}
      {downloadLabel}
    </Button>
  ) : href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      download={name}
      className="inline-flex items-center rounded-md border border-edge px-2.5 py-1.5 text-xs font-medium text-fg hover:bg-surface-muted"
    >
      <Download size={14} className="mr-1.5" />
      {downloadLabel}
    </a>
  ) : null;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-edge bg-surface-card px-3 py-2.5">
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-primary-700">
        <FileDown size={18} aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-semibold text-fg" title={name}>
          {name}
        </div>
        {meta && <div className="mt-0.5 text-[10px] text-fg-faint">{meta}</div>}
      </div>
      {secondaryAction}
      {action}
    </div>
  );
}
