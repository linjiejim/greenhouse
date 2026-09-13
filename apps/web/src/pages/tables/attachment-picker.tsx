import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Dialog, EmptyState, Spinner } from '../../components/ui';
import { ChevronRight, FileText, Folder, Paperclip, Upload, X } from '../../lib/icons';
import {
  driveBreadcrumb,
  formatFileSize,
  listDriveFiles,
  listDriveFolders,
  uploadDriveFile,
  type DriveFile,
  type DriveFolder,
} from '../../lib/api/drive';
import { useT } from '../../lib/i18n';

interface AttachmentPickerProps {
  baseId: number;
  value: Array<number | string>;
  onChange: (value: Array<number | string>) => void;
}

export function AttachmentPicker({ baseId, value, onChange }: AttachmentPickerProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [folderId, setFolderId] = useState<number | null>(null);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [crumbs, setCrumbs] = useState<DriveFolder[]>([]);
  const [knownFiles, setKnownFiles] = useState<Record<number, DriveFile>>({});
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const owner = useMemo(() => ({ scope: 'tables' as const, base_id: baseId }), [baseId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextFolders, nextFiles, nextCrumbs] = await Promise.all([
        listDriveFolders(owner, folderId),
        listDriveFiles(owner, folderId),
        folderId ? driveBreadcrumb(folderId) : Promise.resolve([]),
      ]);
      setFolders(nextFolders);
      setFiles(nextFiles);
      setCrumbs(nextCrumbs);
      setKnownFiles((current) => ({
        ...current,
        ...Object.fromEntries(nextFiles.map((file) => [file.id, file])),
      }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('tables.attachments.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [folderId, owner, t]);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  const selectedIds = new Set(value.filter((entry): entry is number => typeof entry === 'number'));
  const toggle = (fileId: number) => {
    onChange(selectedIds.has(fileId) ? value.filter((entry) => entry !== fileId) : [...value, fileId]);
  };

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    setError('');
    try {
      for (const file of Array.from(list)) await uploadDriveFile(owner, folderId, file);
      await load();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : t('tables.attachments.uploadFailed'));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <>
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {value.map((entry) => {
            const file = typeof entry === 'number' ? knownFiles[entry] : undefined;
            return (
              <span
                key={String(entry)}
                className="inline-flex items-center gap-1 rounded-md border border-edge bg-surface-sunken px-2 py-1 text-xs text-fg-secondary"
              >
                <Paperclip size={11} />
                {file?.name ?? t('tables.attachments.fileNumber', { id: entry })}
                <button
                  type="button"
                  className="ml-1 text-fg-faint hover:text-danger"
                  onClick={() => onChange(value.filter((item) => item !== entry))}
                >
                  <X size={11} />
                </button>
              </span>
            );
          })}
          {value.length === 0 && <span className="text-xs text-fg-faint">{t('tables.attachments.noneSelected')}</span>}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Paperclip size={13} className="mr-1.5" />
          {t('tables.attachments.chooseOrUpload')}
        </Button>
      </div>

      <Dialog open={open} onClose={() => setOpen(false)} title={t('tables.attachments.baseFiles')} size="lg">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-fg-muted">
              <button type="button" className="hover:text-fg" onClick={() => setFolderId(null)}>
                {t('tables.attachments.allFiles')}
              </button>
              {crumbs.map((crumb) => (
                <React.Fragment key={crumb.id}>
                  <ChevronRight size={11} className="text-fg-faint" />
                  <button
                    type="button"
                    className="max-w-36 truncate hover:text-fg"
                    onClick={() => setFolderId(crumb.id)}
                  >
                    {crumb.name}
                  </button>
                </React.Fragment>
              ))}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
            >
              {uploading ? <Spinner /> : <Upload size={13} className="mr-1.5" />}
              {t('common.upload')}
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => void upload(event.target.files)}
            />
          </div>
          {error && <p className="rounded-md bg-danger-subtle px-3 py-2 text-xs text-danger">{error}</p>}
          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : folders.length === 0 && files.length === 0 ? (
            <EmptyState
              icon={Paperclip}
              variant="compact"
              tone="neutral"
              title={t('tables.attachments.emptyTitle')}
              description={t('tables.attachments.emptyDescription')}
            />
          ) : (
            <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-edge">
              {folders.map((folder) => (
                <button
                  key={`folder-${folder.id}`}
                  type="button"
                  className="flex w-full items-center gap-3 border-b border-edge px-3 py-2.5 text-left hover:bg-surface-muted"
                  onClick={() => setFolderId(folder.id)}
                >
                  <Folder size={17} className="text-info" />
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{folder.name}</span>
                  <ChevronRight size={13} className="text-fg-faint" />
                </button>
              ))}
              {files.map((file) => (
                <label
                  key={file.id}
                  className="flex cursor-pointer items-center gap-3 border-b border-edge px-3 py-2.5 last:border-b-0 hover:bg-surface-muted"
                >
                  <Checkbox
                    checked={selectedIds.has(file.id)}
                    onChange={() => toggle(file.id)}
                    aria-label={file.name}
                  />
                  <FileText size={17} className="text-fg-muted" />
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{file.name}</span>
                  <span className="text-[11px] text-fg-faint">{formatFileSize(file.size)}</span>
                </label>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between border-t border-edge pt-3">
            <span className="text-xs text-fg-faint">{t('common.selected', { count: selectedIds.size })}</span>
            <Button type="button" onClick={() => setOpen(false)}>
              {t('common.done')}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
