/**
 * MediaPreviewDialog — Lightbox-style preview for images, videos, and PDFs.
 *
 * Features:
 * - Image preview with object-fit contain
 * - Video player with controls
 * - PDF viewer via iframe
 * - Left/Right navigation between media files
 * - Keyboard shortcuts: ←/→ arrows, Escape to close
 * - Download button
 * - Counter "1 / N"
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Dialog } from './ui';
import { ArrowLeft, ArrowRight, Download, FileText, Image as ImageIcon } from '../lib/icons';
import { useT } from '../lib/i18n';

export interface MediaFile {
  src: string;
  type: string; // 'image' | 'video' | 'pdf' | other
  name?: string;
}

interface MediaPreviewDialogProps {
  open: boolean;
  files: MediaFile[];
  initialIndex?: number;
  onClose: () => void;
}

function getMediaCategory(file: MediaFile): 'image' | 'video' | 'pdf' | 'other' {
  const t = file.type?.toLowerCase() ?? '';
  if (t === 'image' || t.startsWith('image/')) return 'image';
  if (t === 'video' || t.startsWith('video/')) return 'video';
  if (t === 'pdf' || t === 'application/pdf') return 'pdf';
  // Fallback: check file extension
  const ext = file.src?.split('?')[0]?.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'avi', 'mkv'].includes(ext)) return 'video';
  if (ext === 'pdf') return 'pdf';
  return 'other';
}

export function MediaPreviewDialog({ open, files, initialIndex = 0, onClose }: MediaPreviewDialogProps) {
  const t = useT();
  const [index, setIndex] = useState(initialIndex);
  const [imgError, setImgError] = useState(false);

  // Reset index when dialog opens or initialIndex changes
  useEffect(() => {
    if (open) {
      setIndex(initialIndex);
      setImgError(false);
    }
  }, [open, initialIndex]);

  // Reset image error when index changes
  useEffect(() => {
    setImgError(false);
  }, [index]);

  const goPrev = useCallback(() => {
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  const goNext = useCallback(() => {
    setIndex((i) => Math.min(files.length - 1, i + 1));
  }, [files.length]);

  const handleDownload = useCallback(() => {
    const file = files[index];
    if (file) window.open(file.src, '_blank');
  }, [files, index]);

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, goPrev, goNext]);

  if (!open || files.length === 0) return null;

  const current = files[index];
  if (!current) return null;
  const category = getMediaCategory(current);
  const hasPrev = index > 0;
  const hasNext = index < files.length - 1;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('media.viewAttachment', { current: index + 1, total: files.length })}
      size="xl"
      noPadding
    >
      <div className="flex flex-col" style={{ height: '70vh' }}>
        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-edge bg-surface-raised flex-shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={goPrev}
              disabled={!hasPrev}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-edge bg-surface-muted text-fg-secondary hover:bg-surface-sunken disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ArrowLeft size={13} /> {t('media.prev')}
            </button>
            <button
              onClick={goNext}
              disabled={!hasNext}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-edge bg-surface-muted text-fg-secondary hover:bg-surface-sunken disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              {t('media.next')} <ArrowRight size={13} />
            </button>
          </div>
          <div className="flex items-center gap-2">
            {current.name && (
              <span className="text-xs text-fg-muted truncate max-w-[200px]" title={current.name}>
                {current.name}
              </span>
            )}
            <button
              onClick={handleDownload}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-edge bg-surface-muted text-fg-secondary hover:bg-surface-sunken transition-colors"
            >
              <Download size={13} /> {t('media.download')}
            </button>
          </div>
        </div>

        {/* Preview area */}
        <div className="flex-1 flex items-center justify-center bg-surface-sunken overflow-hidden p-4">
          {category === 'image' && !imgError && (
            <img
              src={current.src}
              alt={current.name || 'Preview'}
              className="max-w-full max-h-full object-contain"
              onError={() => setImgError(true)}
            />
          )}
          {category === 'image' && imgError && (
            <div className="flex flex-col items-center gap-2 text-fg-faint">
              <ImageIcon size={48} />
              <span className="text-sm">{t('media.imageLoadFailed')}</span>
              <button
                onClick={handleDownload}
                className="text-xs text-primary-fg hover:underline flex items-center gap-1"
              >
                <Download size={12} /> {t('media.tryDownload')}
              </button>
            </div>
          )}
          {category === 'video' && (
            <video
              src={current.src}
              controls
              preload="metadata"
              className="max-w-full max-h-full"
              style={{ outline: 'none' }}
            >
              {t('media.videoNotSupported')}
            </video>
          )}
          {category === 'pdf' && (
            <iframe
              src={`${current.src}#toolbar=1&navpanes=1&scrollbar=1`}
              className="w-full h-full border-none rounded-md"
              title={current.name || 'PDF Preview'}
            />
          )}
          {category === 'other' && (
            <div className="flex flex-col items-center gap-2 text-fg-faint">
              <FileText size={48} />
              <span className="text-sm">{current.name || t('media.unknownFile')}</span>
              <button
                onClick={handleDownload}
                className="text-xs text-primary-fg hover:underline flex items-center gap-1"
              >
                <Download size={12} /> {t('media.downloadFile')}
              </button>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
