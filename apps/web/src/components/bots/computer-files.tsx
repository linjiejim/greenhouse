/**
 * The computer's files — the member's view of the Bots' home folder
 * (/home/agent): browse it, download what a Bot made, upload what it should
 * work on (button or drag-and-drop onto the tab, ≤ 100 MB per file, with
 * progress). Paths resolve like the computer tool (`~` = /home/agent; the
 * server keeps every path inside it) and the routes need no take-over lease.
 *
 * Uploads run one at a time in the order they were added, so the progress
 * bar means something; they keep going while another tab is showing (the
 * pane keeps this tab mounted once opened).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ComputerFileEntry, ComputerFileList } from '@greenhouse/types/bots';
import { Button, EmptyState, IconButton, Spinner, toast } from '../ui';
import {
  AlertTriangle,
  ChevronRight,
  Download,
  FileIcon,
  Folder,
  FolderOpen,
  House,
  Link,
  RefreshCw,
  Upload,
  X,
  type LucideIcon,
} from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import {
  COMPUTER_UPLOAD_MAX_BYTES,
  downloadComputerFile,
  isBotsApiError,
  listComputerFiles,
  uploadComputerFile,
} from '../../lib/api/bots';
import { formatFileSize } from '../../lib/file-download';
import { formatDate } from '../../lib/utils';
import { computerErrorKey, computerErrorText } from './computer-pane';

const HOME = '/home/agent';

const SHORTCUTS: ReadonlyArray<{ path: string; hint: TranslationKey }> = [
  { path: '~/work', hint: 'botsComputer.files_workHint' },
  { path: '~/Downloads', hint: 'botsComputer.files_downloadsHint' },
  { path: '~', hint: 'botsComputer.files_homeHint' },
];

/** The folders between home and `path`: "/home/agent/work/a" (or "~/work/a") → ["work", "a"]. */
export function homeSegments(path: string): string[] {
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '~' || trimmed === HOME) return [];
  const rest = trimmed.startsWith(`${HOME}/`)
    ? trimmed.slice(HOME.length + 1)
    : trimmed.startsWith('~/')
      ? trimmed.slice(2)
      : trimmed;
  return rest.split('/').filter(Boolean);
}

/** How the member reads a folder: "~/work/a". */
export function displayPath(path: string): string {
  const segments = homeSegments(path);
  return segments.length > 0 ? `~/${segments.join('/')}` : '~';
}

function absolutePath(segments: readonly string[]): string {
  return segments.length > 0 ? `${HOME}/${segments.join('/')}` : HOME;
}

const ENTRY_ICON: Record<ComputerFileEntry['type'], LucideIcon> = {
  dir: Folder,
  file: FileIcon,
  link: Link,
  other: FileIcon,
};

interface UploadRow {
  id: number;
  name: string;
  size: number;
  loaded: number;
  state: 'queued' | 'uploading' | 'done' | 'failed';
  error?: string;
}

type Translate = ReturnType<typeof useT>;

/**
 * A code the computer routes answer with (stopped, over_quota, not_found,
 * too_large…) reads as that sentence; a code-less 413 (a proxy's own limit) is
 * still "too large"; anything else names the file.
 */
function fileErrorText(
  t: Translate,
  err: unknown,
  name: string,
  fallback: 'botsComputer.files_uploadFailed' | 'botsComputer.files_downloadFailed',
): string {
  const shared = computerErrorKey(err);
  if (shared) return t(shared);
  if (isBotsApiError(err) && err.status === 413) return t('botsComputer.err_tooLarge');
  return t(fallback, { name });
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export interface ComputerFilesProps {
  /** The Files tab is the one showing (it re-reads the folder when shown again). */
  active: boolean;
  /** A call found the computer stopped: let the owner refresh its status. */
  onStale?: () => void;
}

export function ComputerFiles({ active, onStale }: ComputerFilesProps) {
  const t = useT();
  const [requested, setRequested] = useState('~/work');
  const [listing, setListing] = useState<ComputerFileList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const loadTicket = useRef(0);
  const listingRef = useRef<ComputerFileList | null>(null);
  listingRef.current = listing;
  const uploadQueue = useRef<Promise<void>>(Promise.resolve());
  const uploadSeq = useRef(0);
  const abort = useRef(new AbortController());
  const onStaleRef = useRef(onStale);
  onStaleRef.current = onStale;

  // Uploads in flight stop with the pane (closing it, the computer going to sleep).
  useEffect(() => {
    const controller = abort.current;
    return () => controller.abort();
  }, []);

  const load = useCallback(
    async (path: string) => {
      const ticket = ++loadTicket.current;
      setLoading(true);
      try {
        const next = await listComputerFiles(path);
        if (ticket !== loadTicket.current) return;
        setListing(next);
        setLoadFailed(null);
      } catch (err) {
        if (ticket !== loadTicket.current) return;
        if (isBotsApiError(err, 'stopped')) onStaleRef.current?.();
        setLoadFailed(computerErrorText(t, err, 'botsComputer.files_loadFailed'));
      } finally {
        if (ticket === loadTicket.current) setLoading(false);
      }
    },
    [t],
  );

  // A new folder, and every return to the tab: the Bots may have changed things meanwhile.
  useEffect(() => {
    if (active) void load(requested);
  }, [active, requested, load]);

  const go = (path: string) => {
    if (path === requested) void load(path);
    else setRequested(path);
  };

  const currentDir = listing?.path ?? requested;
  const segments = homeSegments(currentDir);

  const updateUpload = (id: number, patch: Partial<UploadRow>) =>
    setUploads((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  const uploadFiles = (files: File[]) => {
    if (files.length === 0) return;
    const dir = listingRef.current?.path ?? requested;
    const batch = files.map((file) => {
      const tooLarge = file.size > COMPUTER_UPLOAD_MAX_BYTES;
      const row: UploadRow = {
        id: ++uploadSeq.current,
        name: file.name,
        size: file.size,
        loaded: 0,
        state: tooLarge ? 'failed' : 'queued',
        error: tooLarge ? t('botsComputer.files_tooLarge', { name: file.name }) : undefined,
      };
      return { row, file };
    });
    setUploads((rows) => [...rows, ...batch.map(({ row }) => row)]);
    const run = async () => {
      let uploaded = 0;
      for (const { row, file } of batch) {
        if (row.state !== 'queued' || abort.current.signal.aborted) continue;
        updateUpload(row.id, { state: 'uploading' });
        try {
          await uploadComputerFile(dir, file, {
            signal: abort.current.signal,
            onProgress: (loaded) => updateUpload(row.id, { loaded }),
          });
          updateUpload(row.id, { state: 'done', loaded: row.size });
          uploaded += 1;
        } catch (err) {
          if (isAbort(err)) return;
          if (isBotsApiError(err, 'stopped')) onStaleRef.current?.();
          updateUpload(row.id, {
            state: 'failed',
            error: fileErrorText(t, err, file.name, 'botsComputer.files_uploadFailed'),
          });
        }
      }
      if (uploaded === 0) return;
      toast(t('botsComputer.files_uploaded', { count: uploaded, dir: displayPath(dir) }), 'success');
      setUploads((rows) => rows.filter((row) => row.state !== 'done'));
      if ((listingRef.current?.path ?? '') === dir) void load(dir);
    };
    uploadQueue.current = uploadQueue.current.then(run, run);
  };

  const download = async (entry: ComputerFileEntry) => {
    const path = `${currentDir.replace(/\/+$/, '')}/${entry.name}`;
    setDownloading(entry.name);
    try {
      await downloadComputerFile(path, entry.name);
    } catch (err) {
      if (isBotsApiError(err, 'stopped')) onStaleRef.current?.();
      toast(fileErrorText(t, err, entry.name, 'botsComputer.files_downloadFailed'), 'error');
    } finally {
      setDownloading(null);
    }
  };

  // ── Drag and drop onto the tab ──
  const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  const onDragEnter = (event: React.DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (event: React.DragEvent) => {
    // Without this the browser would open the dropped file in place of the app.
    if (hasFiles(event)) event.preventDefault();
  };
  const onDragLeave = (event: React.DragEvent) => {
    if (!hasFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: React.DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDragging(false);
    uploadFiles(Array.from(event.dataTransfer.files));
  };

  const entries = listing?.entries ?? [];

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col gap-2.5"
      data-testid="computer-files"
      data-path={currentDir}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary-400 bg-primary-subtle/80"
          data-testid="computer-files-drop"
        >
          <p className="flex items-center gap-2 px-4 text-center text-sm font-medium text-primary-fg-strong">
            <Upload size={16} aria-hidden="true" />
            {t('botsComputer.files_dropHere', { dir: displayPath(currentDir) })}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <nav
          aria-label={t('botsComputer.files_path')}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-xs text-fg-muted"
          data-testid="computer-files-breadcrumb"
        >
          <button
            type="button"
            className="inline-flex min-h-6 items-center rounded px-1 transition-colors hover:bg-surface-muted hover:text-fg"
            onClick={() => go(HOME)}
            aria-label={t('botsComputer.files_home')}
            title={HOME}
          >
            <House size={14} aria-hidden="true" />
          </button>
          {segments.map((segment, index) => {
            const last = index === segments.length - 1;
            return (
              <React.Fragment key={`${index}:${segment}`}>
                <ChevronRight size={12} className="flex-shrink-0 text-fg-faint" aria-hidden="true" />
                {last ? (
                  <span className="max-w-[12rem] truncate font-medium text-fg" title={segment} aria-current="page">
                    {segment}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="max-w-[10rem] truncate rounded px-1 transition-colors hover:bg-surface-muted hover:text-fg"
                    title={segment}
                    onClick={() => go(absolutePath(segments.slice(0, index + 1)))}
                  >
                    {segment}
                  </button>
                )}
              </React.Fragment>
            );
          })}
        </nav>
        <IconButton label={t('botsComputer.refresh')} onClick={() => go(requested)} tooltip="top">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </IconButton>
        <Button
          size="sm"
          variant="outline"
          onClick={() => inputRef.current?.click()}
          data-testid="computer-files-upload"
        >
          <Upload size={14} className="mr-1" aria-hidden="true" />
          {t('botsComputer.files_upload')}
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          data-testid="computer-files-input"
          onChange={(event) => {
            uploadFiles(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {SHORTCUTS.map((shortcut) => (
          <Button
            key={shortcut.path}
            size="sm"
            variant="ghost"
            className="border border-edge font-mono"
            title={t(shortcut.hint)}
            onClick={() => go(shortcut.path)}
            data-testid={`computer-files-shortcut-${shortcut.path === '~' ? 'home' : shortcut.path.slice(2).toLowerCase()}`}
          >
            {shortcut.path}
          </Button>
        ))}
      </div>

      {uploads.length > 0 && (
        <UploadList rows={uploads} onDismiss={(id) => setUploads((rows) => rows.filter((row) => row.id !== id))} />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loadFailed && !loading ? (
          <EmptyState
            variant="compact"
            tone="danger"
            icon={AlertTriangle}
            title={loadFailed}
            action={
              <Button size="sm" variant="outline" onClick={() => go(requested)}>
                {t('botsComputer.retry')}
              </Button>
            }
          />
        ) : !listing ? (
          <div className="flex justify-center py-8" role="status" aria-label={t('common.loading')}>
            <Spinner />
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            variant="compact"
            tone="neutral"
            icon={FolderOpen}
            title={t('botsComputer.files_empty')}
            description={t('botsComputer.files_emptyHint')}
          />
        ) : (
          <>
            <ul
              className="divide-y divide-edge overflow-hidden rounded-lg border border-edge"
              data-testid="computer-file-list"
            >
              {entries.map((entry) => (
                <FileRow
                  key={entry.name}
                  entry={entry}
                  downloading={downloading === entry.name}
                  onOpen={() => go(`${currentDir.replace(/\/+$/, '')}/${entry.name}`)}
                  onDownload={() => void download(entry)}
                />
              ))}
            </ul>
            {listing.truncated && (
              <p className="mt-2 text-[11px] text-fg-faint">
                {t('botsComputer.files_truncated', { count: entries.length })}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FileRow({
  entry,
  downloading,
  onOpen,
  onDownload,
}: {
  entry: ComputerFileEntry;
  downloading: boolean;
  onOpen: () => void;
  onDownload: () => void;
}) {
  const t = useT();
  const Icon = ENTRY_ICON[entry.type] ?? FileIcon;
  // A link may point at a folder or a file: it can be opened, and downloaded.
  const opens = entry.type === 'dir' || entry.type === 'link';
  const downloads = entry.type === 'file' || entry.type === 'link';
  const meta = [entry.type === 'file' ? formatFileSize(entry.size) : null, formatDate(entry.mtime)]
    .filter(Boolean)
    .join(' · ');
  const body = (
    <>
      <Icon
        size={18}
        className={`flex-shrink-0 ${entry.type === 'dir' ? 'text-info' : 'text-fg-muted'}`}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-fg" title={entry.name}>
          {entry.name}
        </span>
        {meta && <span className="block truncate text-[11px] text-fg-faint">{meta}</span>}
      </span>
    </>
  );
  return (
    <li
      className="flex items-center gap-1 pl-3 pr-1 transition-colors hover:bg-surface-muted"
      data-testid="computer-file-row"
      data-type={entry.type}
    >
      {opens ? (
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-2.5 py-2 text-left"
          aria-label={t('botsComputer.files_open', { name: entry.name })}
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2.5 py-2">{body}</div>
      )}
      {downloads && (
        <IconButton
          label={t('botsComputer.files_download', { name: entry.name })}
          onClick={onDownload}
          disabled={downloading}
          tooltip="top"
          data-testid="computer-file-download"
        >
          {downloading ? <Spinner className="h-3.5 w-3.5" /> : <Download size={14} />}
        </IconButton>
      )}
    </li>
  );
}

function UploadList({ rows, onDismiss }: { rows: UploadRow[]; onDismiss: (id: number) => void }) {
  const t = useT();
  return (
    <ul className="space-y-1.5" aria-label={t('botsComputer.files_uploading')} data-testid="computer-uploads">
      {rows.map((row) => {
        const percent = row.size > 0 ? Math.min(100, Math.round((row.loaded / row.size) * 100)) : 0;
        return (
          <li
            key={row.id}
            className="rounded-lg border border-edge bg-surface-card px-2.5 py-1.5 text-xs"
            data-testid="computer-upload"
            data-state={row.state}
          >
            <div className="flex items-center gap-2">
              {row.state === 'failed' ? (
                <AlertTriangle size={14} className="flex-shrink-0 text-danger" aria-hidden="true" />
              ) : row.state === 'uploading' ? (
                <Spinner className="h-3.5 w-3.5 flex-shrink-0 text-primary-fg" />
              ) : (
                <Upload size={14} className="flex-shrink-0 text-fg-faint" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 truncate text-fg" title={row.name}>
                {row.name}
              </span>
              {row.state === 'failed' ? (
                <IconButton size="compact" label={t('botsComputer.files_dismiss')} onClick={() => onDismiss(row.id)}>
                  <X size={12} />
                </IconButton>
              ) : (
                <span className="flex-shrink-0 tabular-nums text-fg-faint">
                  {row.state === 'uploading' ? `${percent}%` : formatFileSize(row.size)}
                </span>
              )}
            </div>
            {row.state === 'failed' ? (
              <p className="mt-0.5 text-[11px] text-danger">{row.error}</p>
            ) : (
              <div
                className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-muted"
                role="progressbar"
                aria-label={row.name}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <div
                  className="h-full rounded-full bg-primary-500 transition-[width]"
                  style={{ width: `${percent}%` }}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
