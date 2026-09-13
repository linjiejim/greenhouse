/**
 * DriveBrowser — a folder/file cabinet for one scope.
 *
 * Reused across surfaces via the `owner` prop:
 *   - Tables Base files:     <DriveBrowser owner={{ scope: 'tables', base_id }} />
 *   - KB folder attachments: <DriveBrowser owner={{ scope: 'kb', visibility }} initialFolderId={id} />
 *
 * Navigates one folder level at a time (breadcrumb walks the parent chain),
 * uploads via the API client (presigned-direct or proxy, transparently), and
 * downloads through the authed content endpoint.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Button, EmptyState, Spinner, ConfirmDialog, Dialog, Input, toast } from '../ui';
import { Folder, FolderPlus, FileText, Upload, Download, Trash2, ChevronRight } from '../../lib/icons';
import {
  listDriveFolders,
  listDriveFiles,
  driveBreadcrumb,
  createDriveFolder,
  deleteDriveFolder,
  deleteDriveFile,
  uploadDriveFile,
  downloadDriveFile,
  formatFileSize,
} from '../../lib/api/drive';
import type { DriveOwner, DriveFolder, DriveFile } from '../../lib/api/drive';
import { formatDate } from '../../lib/utils';
import { useT } from '../../lib/i18n';

interface Props {
  owner: DriveOwner;
  /** Start inside a specific folder instead of the scope root (kb folder pages). */
  initialFolderId?: number | null;
  /**
   * Called after the cabinet's contents change (upload / delete / new folder),
   * so a host that shows a file count can refresh
   * it. Must be referentially stable — pass a useCallback.
   */
  onMutate?: () => void;
}

export function DriveBrowser({ owner, initialFolderId = null, onMutate }: Props) {
  const t = useT();
  const [folderId, setFolderId] = useState<number | null>(initialFolderId);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [crumbs, setCrumbs] = useState<DriveFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [confirm, setConfirm] = useState<{ kind: 'file' | 'folder'; id: number; name: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // owner is stable per surface; collapse to a primitive for the effect dep.
  const ownerKey = owner.scope === 'tables' ? `tables:${owner.base_id}` : `kb:${owner.visibility}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [fld, fls, crmb] = await Promise.all([
        listDriveFolders(owner, folderId),
        listDriveFiles(owner, folderId),
        folderId != null ? driveBreadcrumb(folderId) : Promise.resolve<DriveFolder[]>([]),
      ]);
      setFolders(fld);
      setFiles(fls);
      setCrumbs(crmb);
    } catch (e) {
      toast((e as Error).message || t('common.loadFailed'), 'error');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey, folderId]);

  useEffect(() => {
    load();
  }, [load]);

  const onUpload = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setUploading(true);
    try {
      for (const f of Array.from(list)) await uploadDriveFile(owner, folderId, f);
      toast(t('drive.uploaded', { count: list.length }), 'success');
      await load();
      onMutate?.();
    } catch (e) {
      toast((e as Error).message || t('drive.uploadFailed'), 'error');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const onCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      await createDriveFolder(owner, folderId, name);
      setNewFolderOpen(false);
      setNewFolderName('');
      await load();
      onMutate?.();
    } catch (e) {
      toast((e as Error).message || t('common.createFailed'), 'error');
    }
  };

  const onConfirmDelete = async () => {
    if (!confirm) return;
    try {
      if (confirm.kind === 'file') await deleteDriveFile(confirm.id);
      else await deleteDriveFolder(confirm.id);
      setConfirm(null);
      await load();
      onMutate?.();
    } catch (e) {
      toast((e as Error).message || t('common.deleteFailed'), 'error');
      setConfirm(null);
    }
  };

  return (
    <div className="space-y-3">
      {/* Breadcrumb + actions */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1 text-xs text-fg-muted flex-wrap min-w-0">
          <button className="hover:text-fg transition-colors" onClick={() => setFolderId(null)}>
            {t('drive.allFiles')}
          </button>
          {crumbs.map((c) => (
            <React.Fragment key={c.id}>
              <ChevronRight size={12} className="text-fg-faint flex-shrink-0" />
              <button
                className="hover:text-fg transition-colors truncate max-w-[160px]"
                title={c.name}
                onClick={() => setFolderId(c.id)}
              >
                {c.name}
              </button>
            </React.Fragment>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button size="sm" variant="ghost" onClick={() => setNewFolderOpen(true)}>
            <FolderPlus size={14} />
            <span className="ml-1">{t('drive.newFolder')}</span>
          </Button>
          <Button size="sm" variant="ghost" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
            {uploading ? <Spinner /> : <Upload size={14} />}
            <span className="ml-1">{uploading ? t('drive.uploading') : t('drive.upload')}</span>
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => onUpload(e.target.files)}
          />
        </div>
      </div>

      {/* Listing */}
      {loading ? (
        <div className="py-8 flex justify-center">
          <Spinner />
        </div>
      ) : folders.length === 0 && files.length === 0 ? (
        <EmptyState
          icon={Folder}
          variant="compact"
          tone="neutral"
          title={t('drive.empty')}
          description={t('drive.emptyHintKb')}
        />
      ) : (
        <div className="border border-edge rounded-lg divide-y divide-edge overflow-hidden">
          {folders.map((f) => (
            <div
              key={`fd${f.id}`}
              className="group flex items-center gap-3 px-3 py-2.5 hover:bg-surface-muted transition-colors"
            >
              <button className="flex items-center gap-3 flex-1 min-w-0 text-left" onClick={() => setFolderId(f.id)}>
                <Folder size={18} className="text-info flex-shrink-0" />
                <span className="text-sm text-fg truncate" title={f.name}>
                  {f.name}
                </span>
              </button>
              <button
                onClick={() => setConfirm({ kind: 'folder', id: f.id, name: f.name })}
                className="opacity-0 group-hover:opacity-100 touch-visible p-1 rounded text-fg-faint hover:text-danger transition-colors"
                title={t('common.delete')}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {files.map((f) => (
            <div
              key={`fl${f.id}`}
              className="group flex items-center gap-3 px-3 py-2.5 hover:bg-surface-muted transition-colors"
            >
              <FileText size={18} className="text-fg-muted flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-fg truncate" title={f.name}>
                  {f.name}
                </div>
                <div className="text-[11px] text-fg-faint">
                  {formatFileSize(f.size)} · {formatDate(f.created_at)}
                </div>
              </div>
              <button
                onClick={() =>
                  downloadDriveFile(f).catch((e) => toast((e as Error).message || t('drive.downloadFailed'), 'error'))
                }
                className="p-1 rounded text-fg-faint hover:text-fg transition-colors"
                title={t('drive.download')}
              >
                <Download size={14} />
              </button>
              <button
                onClick={() => setConfirm({ kind: 'file', id: f.id, name: f.name })}
                className="opacity-0 group-hover:opacity-100 touch-visible p-1 rounded text-fg-faint hover:text-danger transition-colors"
                title={t('common.delete')}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* New folder dialog */}
      <Dialog open={newFolderOpen} onClose={() => setNewFolderOpen(false)} title={t('drive.newFolder')} size="sm">
        <div className="space-y-3">
          <Input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder={t('drive.folderName')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCreateFolder();
            }}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setNewFolderOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={onCreateFolder} disabled={!newFolderName.trim()}>
              {t('common.create')}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={onConfirmDelete}
        title={confirm?.kind === 'folder' ? t('drive.deleteFolderTitle') : t('drive.deleteFileTitle')}
        description={
          confirm
            ? t(confirm.kind === 'folder' ? 'drive.deleteFolderConfirm' : 'drive.deleteFileConfirm', {
                name: confirm.name,
              })
            : undefined
        }
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
      />
    </div>
  );
}
