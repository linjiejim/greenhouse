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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from './ui';
import {
  ArrowLeft,
  ArrowRight,
  Download,
  FileText,
  Image as ImageIcon,
  Maximize2,
  Pencil,
  ZoomIn,
  ZoomOut,
} from '../lib/icons';
import { useT } from '../lib/i18n';
import { openSidePane, useSidePaneStore } from '../stores/side-pane-store';

export interface MediaFile {
  id?: string;
  src: string;
  type: string; // 'image' | 'video' | 'pdf' | other
  name?: string;
}

/** Annotation can only preserve the clean original when it is one of our
 * authenticated uploads. External images may also taint the export canvas. */
function uploadImageId(file: MediaFile): string | null {
  if (file.id) return file.id;
  const relative = file.src.match(/^\/api\/upload\/([^/?#]+)(?:[?#].*)?$/);
  if (relative?.[1]) {
    try {
      return decodeURIComponent(relative[1]);
    } catch {
      return null;
    }
  }
  if (typeof window === 'undefined') return null;
  try {
    const url = new URL(file.src, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/upload/')) return null;
    const id = url.pathname.slice('/api/upload/'.length);
    return id && !id.includes('/') ? decodeURIComponent(id) : null;
  } catch {
    return null;
  }
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

/** Zoom range and step for the image viewer. 1 = fit to the frame. */
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 0.5;

export function MediaPreviewDialog({ open, files, initialIndex = 0, onClose }: MediaPreviewDialogProps) {
  const t = useT();
  const [index, setIndex] = useState(initialIndex);
  const [imgError, setImgError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(
    null,
  );
  const sidePaneAvailable = useSidePaneStore((state) => state.hostMounted);

  const resetView = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // Reset index when dialog opens or initialIndex changes
  useEffect(() => {
    if (open) {
      setIndex(initialIndex);
      setImgError(false);
      resetView();
    }
  }, [open, initialIndex, resetView]);

  // Reset image error and framing when index changes
  useEffect(() => {
    setImgError(false);
    resetView();
  }, [index, resetView]);

  /**
   * Zoom about the frame centre. Functional update on purpose: two clicks landing
   * in one React batch would otherwise both read the same rendered `zoom` and
   * collapse into a single step.
   */
  const zoomBy = useCallback((delta: number) => {
    setZoom((prev) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((prev + delta) * 100) / 100)));
  }, []);

  // Back at 1× the image fits the frame, so any leftover pan would only push it
  // off-centre with no way to see what's missing.
  useEffect(() => {
    if (zoom === MIN_ZOOM) setOffset({ x: 0, y: 0 });
  }, [zoom]);

  const onImagePointerDown = useCallback(
    (e: React.PointerEvent<HTMLImageElement>) => {
      if (zoom <= MIN_ZOOM) return;
      panRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        originX: offset.x,
        originY: offset.y,
      };
      // Pointer capture throws NotFoundError when the pointer is already gone;
      // it sits at the top of the handler, so an uncaught throw kills the pan.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture is an optimisation, not a requirement */
      }
    },
    [offset.x, offset.y, zoom],
  );

  const onImagePointerMove = useCallback((e: React.PointerEvent<HTMLImageElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== e.pointerId) return;
    e.preventDefault();
    setOffset({ x: pan.originX + (e.clientX - pan.startX), y: pan.originY + (e.clientY - pan.startY) });
  }, []);

  const endPan = useCallback((e: React.PointerEvent<HTMLImageElement>) => {
    if (panRef.current?.pointerId !== e.pointerId) return;
    panRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }, []);

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

  // Keyboard navigation + zoom
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomBy(ZOOM_STEP);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomBy(-ZOOM_STEP);
      } else if (e.key === '0') {
        e.preventDefault();
        resetView();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, goPrev, goNext, zoomBy, resetView]);

  if (!open || files.length === 0) return null;

  const current = files[index];
  if (!current) return null;
  const category = getMediaCategory(current);
  const hasPrev = index > 0;
  const hasNext = index < files.length - 1;
  const imageId = category === 'image' ? uploadImageId(current) : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('media.viewAttachment', { current: index + 1, total: files.length })}
      size="workspace"
      noPadding
      scrollBody={false}
    >
      {/* Taller than a generic dialog on purpose: this is the "look at the detail"
          surface, and zooming is useless if the frame is small to begin with. */}
      <div className="flex h-[85dvh] max-h-full min-h-0 flex-col">
        {/* Toolbar */}
        <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-edge bg-surface-raised px-2 py-2 sm:px-4">
          <div className="flex flex-shrink-0 items-center gap-1 sm:gap-2">
            <button
              onClick={goPrev}
              disabled={!hasPrev}
              aria-label={t('media.prev')}
              className="flex h-11 w-11 items-center justify-center gap-1 rounded-md border border-edge bg-surface-muted text-xs text-fg-secondary transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-30 sm:h-auto sm:w-auto sm:px-2.5 sm:py-1.5"
            >
              <ArrowLeft size={15} /> <span className="hidden sm:inline">{t('media.prev')}</span>
            </button>
            <button
              onClick={goNext}
              disabled={!hasNext}
              aria-label={t('media.next')}
              className="flex h-11 w-11 items-center justify-center gap-1 rounded-md border border-edge bg-surface-muted text-xs text-fg-secondary transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-30 sm:h-auto sm:w-auto sm:px-2.5 sm:py-1.5"
            >
              <span className="hidden sm:inline">{t('media.next')}</span> <ArrowRight size={15} />
            </button>
          </div>
          {category === 'image' && !imgError && (
            <div className="flex flex-shrink-0 items-center gap-1">
              <button
                onClick={() => zoomBy(-ZOOM_STEP)}
                disabled={zoom <= MIN_ZOOM}
                aria-label={t('media.zoomOut')}
                title={t('media.zoomOut')}
                className="flex h-11 w-11 items-center justify-center rounded-md border border-edge bg-surface-muted text-fg-secondary transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-30 sm:h-8 sm:w-8"
              >
                <ZoomOut size={15} />
              </button>
              <button
                onClick={resetView}
                aria-label={t('media.resetZoom')}
                title={t('media.resetZoom')}
                className="flex h-11 min-w-[3.5rem] items-center justify-center gap-1 rounded-md border border-edge bg-surface-muted px-1 text-xs tabular-nums text-fg-secondary transition-colors hover:bg-surface-sunken sm:h-8"
              >
                <Maximize2 size={13} /> {Math.round(zoom * 100)}%
              </button>
              <button
                onClick={() => zoomBy(ZOOM_STEP)}
                disabled={zoom >= MAX_ZOOM}
                aria-label={t('media.zoomIn')}
                title={t('media.zoomIn')}
                className="flex h-11 w-11 items-center justify-center rounded-md border border-edge bg-surface-muted text-fg-secondary transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-30 sm:h-8 sm:w-8"
              >
                <ZoomIn size={15} />
              </button>
            </div>
          )}
          <div className="flex min-w-0 items-center justify-end gap-2">
            {current.name && (
              <span
                className="hidden min-w-0 max-w-[200px] truncate text-xs text-fg-muted sm:inline"
                title={current.name}
              >
                {current.name}
              </span>
            )}
            {imageId && sidePaneAvailable && (
              <button
                onClick={() => {
                  openSidePane({ kind: 'image-annotate', src: current.src, imageId });
                  onClose();
                }}
                aria-label={t('annotate.open')}
                className="flex h-11 w-11 flex-shrink-0 items-center justify-center gap-1 rounded-md border border-edge bg-surface-muted text-xs text-fg-secondary transition-colors hover:bg-surface-sunken sm:h-auto sm:w-auto sm:px-2.5 sm:py-1.5"
              >
                <Pencil size={15} /> <span className="hidden sm:inline">{t('annotate.open')}</span>
              </button>
            )}
            <button
              onClick={handleDownload}
              aria-label={t('media.download')}
              className="flex h-11 w-11 flex-shrink-0 items-center justify-center gap-1 rounded-md border border-edge bg-surface-muted text-xs text-fg-secondary transition-colors hover:bg-surface-sunken sm:h-auto sm:w-auto sm:px-2.5 sm:py-1.5"
            >
              <Download size={15} /> <span className="hidden sm:inline">{t('media.download')}</span>
            </button>
          </div>
        </div>

        {/* Preview area */}
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-surface-sunken p-2 sm:p-4">
          {category === 'image' && !imgError && (
            <img
              src={current.src}
              alt={current.name || 'Preview'}
              className="max-h-full max-w-full touch-none select-none object-contain"
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
                // No transition while dragging — a lagging image feels broken.
                transition: panRef.current ? 'none' : 'transform 120ms ease-out',
                cursor: zoom > MIN_ZOOM ? (panRef.current ? 'grabbing' : 'grab') : 'zoom-in',
              }}
              draggable={false}
              onPointerDown={onImagePointerDown}
              onPointerMove={onImagePointerMove}
              onPointerUp={endPan}
              onPointerCancel={endPan}
              onDoubleClick={() => (zoom > MIN_ZOOM ? resetView() : setZoom(2))}
              onWheel={(e) => {
                // Trackpad pinch arrives as ctrl+wheel; plain wheel keeps scrolling
                // the page behind, which is what a reader expects at 100%.
                if (!e.ctrlKey && zoom === MIN_ZOOM) return;
                zoomBy(-Math.sign(e.deltaY) * ZOOM_STEP);
              }}
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
