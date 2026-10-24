/**
 * DriveBrowser — a folder/file cabinet for one scope.
 *
 * Reused across surfaces via the `owner` prop:
 *   - Files (云盘):         <DriveBrowser owner={{ scope: 'kb', visibility }} folderId={…} onFolderChange={…} />
 *   - Tables Base files:     <DriveBrowser owner={{ scope: 'tables', base_id }} />
 *   - KB folder attachments: <DriveBrowser owner={{ scope: 'kb', visibility }} initialFolderId={id} />
 *   - an extension's cabinet:  <DriveBrowser owner={{ scope: 'crm', owner_key: String(companyId) }} />
 *
 * Navigates one folder level at a time (breadcrumb walks the parent chain),
 * uploads via the API client (presigned-direct or proxy, transparently),
 * previews images / PDFs / text, renames and moves within the cabinet, and
 * downloads through the authed content endpoint. The server authorizes every
 * action; a refusal comes back as a toast.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Button, EmptyState, Spinner, ConfirmDialog, Dialog, Input, toast } from '../ui';
import {
  Folder,
  FolderPlus,
  FolderInput,
  FileText,
  Upload,
  Download,
  Trash2,
  ChevronRight,
  Pencil,
} from '../../lib/icons';
import {
  listDriveFolders,
  listDriveFiles,
  driveBreadcrumb,
  createDriveFolder,
  deleteDriveFolder,
  deleteDriveFile,
  updateDriveFile,
  updateDriveFolder,
  uploadDriveFile,
  downloadDriveFile,
  formatFileSize,
  isExtensionDriveOwner,
} from '../../lib/api/drive';
import type { DriveOwner, DriveFolder, DriveFile } from '../../lib/api/drive';
import { formatDate } from '../../lib/utils';
import { useT } from '../../lib/i18n';
import { DriveFilePreview, drivePreviewKind } from './drive-file-preview';
import { DriveMoveDialog, DriveRenameDialog } from './drive-dialogs';

interface Props {
  owner: DriveOwner;
  /** Start inside a specific folder instead of the scope root (kb folder pages). */
  initialFolderId?: number | null;
  /**
   * Called after the cabinet's contents change (upload / delete / new folder /
   * rename / move), so a host that shows a file count can refresh it. Must be
   * referentially stable — pass a useCallback.
   */
  onMutate?: () => void;
  /**
   * Controlled mode: the host owns the open folder (Files keeps it in the URL).
   * When `onFolderChange` is set, `folderId` is the source of truth.
   */
  folderId?: number | null;
  onFolderChange?: (folderId: number | null) => void;
  /** Open this file's preview once it is listed (a deep link), and say when it closes. */
  previewFileId?: number | null;
  onPreviewClose?: () => void;
}

type Target = { kind: 'file'; item: DriveFile } | { kind: 'folder'; item: DriveFolder };

/**
 * One step of the deep-link preview: open the named file once it is listed,
 * not again while the link stays, and forget it when the link clears — so
 * coming Back to the same link opens the preview again.
 */
export function deepLinkPreview(
  handled: number | null,
  previewFileId: number | null,
  files: readonly DriveFile[],
): { handled: number | null; open: DriveFile | null } {
  if (!previewFileId) return { handled: null, open: null };
  if (handled === previewFileId) return { handled, open: null };
  const file = files.find((candidate) => candidate.id === previewFileId);
  if (!file) return { handled, open: null };
  return { handled: previewFileId, open: drivePreviewKind(file) ? file : null };
}

const iconButton =
  'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 touch-visible p-1 rounded text-fg-faint transition-colors';

export function DriveBrowser({
  owner,
  initialFolderId = null,
  onMutate,
  folderId: controlledFolderId,
  onFolderChange,
  previewFileId = null,
  onPreviewClose,
}: Props) {
  const t = useT();
  const controlled = onFolderChange !== undefined;
  const [ownFolderId, setOwnFolderId] = useState<number | null>(initialFolderId);
  const folderId = controlled ? (controlledFolderId ?? null) : ownFolderId;
  const openFolder = useCallback(
    (id: number | null) => (controlled ? onFolderChange?.(id) : setOwnFolderId(id)),
    [controlled, onFolderChange],
  );
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [crumbs, setCrumbs] = useState<DriveFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [confirm, setConfirm] = useState<{ kind: 'file' | 'folder'; id: number; name: string } | null>(null);
  const [renaming, setRenaming] = useState<Target | null>(null);
  const [moving, setMoving] = useState<Target | null>(null);
  const [preview, setPreview] = useState<DriveFile | null>(null);
  const deepLinkHandled = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // owner is stable per surface; collapse to a primitive for the effect dep.
  const ownerKey = isExtensionDriveOwner(owner)
    ? `${owner.scope}:${owner.owner_key}`
    : owner.scope === 'tables'
      ? `tables:${owner.base_id}`
      : `kb:${owner.visibility}`;

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

  // A deep link names a file: open its preview once it shows up in the listing.
  useEffect(() => {
    const step = deepLinkPreview(deepLinkHandled.current, previewFileId, files);
    deepLinkHandled.current = step.handled;
    if (step.open) setPreview(step.open);
  }, [files, previewFileId]);

  const afterChange = async () => {
    await load();
    onMutate?.();
  };

  const run = async (work: () => Promise<unknown>, failure: string) => {
    try {
      await work();
      await afterChange();
    } catch (e) {
      toast((e as Error).message || failure, 'error');
    }
  };

  const onUpload = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setUploading(true);
    try {
      for (const f of Array.from(list)) await uploadDriveFile(owner, folderId, f);
      toast(t('drive.uploaded', { count: list.length }), 'success');
      await afterChange();
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
    await run(async () => {
      await createDriveFolder(owner, folderId, name);
      setNewFolderOpen(false);
      setNewFolderName('');
    }, t('common.createFailed'));
  };

  const onConfirmDelete = async () => {
    if (!confirm) return;
    const target = confirm;
    setConfirm(null);
    await run(
      () => (target.kind === 'file' ? deleteDriveFile(target.id) : deleteDriveFolder(target.id)),
      t('common.deleteFailed'),
    );
  };

  const onRename = async (name: string) => {
    const target = renaming;
    setRenaming(null);
    if (!target) return;
    await run(
      () =>
        target.kind === 'file'
          ? updateDriveFile(target.item.id, { name })
          : updateDriveFolder(target.item.id, { name }),
      t('common.saveFailed'),
    );
  };

  const onMove = async (destination: number | null) => {
    const target = moving;
    setMoving(null);
    if (!target) return;
    await run(
      () =>
        target.kind === 'file'
          ? updateDriveFile(target.item.id, { folder_id: destination })
          : updateDriveFolder(target.item.id, { parent_id: destination }),
      t('common.saveFailed'),
    );
  };

  const download = (file: DriveFile) =>
    downloadDriveFile(file).catch((e) => toast((e as Error).message || t('drive.downloadFailed'), 'error'));

  const rowActions = (target: Target) => (
    <>
      <button
        onClick={() => setRenaming(target)}
        className={`${iconButton} hover:text-fg`}
        title={t('drive.rename')}
        aria-label={t('drive.rename')}
      >
        <Pencil size={14} />
      </button>
      <button
        onClick={() => setMoving(target)}
        className={`${iconButton} hover:text-fg`}
        title={t('drive.move')}
        aria-label={t('drive.move')}
      >
        <FolderInput size={14} />
      </button>
    </>
  );

  return (
    <div className="space-y-3">
      {/* Breadcrumb + actions */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1 text-xs text-fg-muted flex-wrap min-w-0">
          <button className="hover:text-fg transition-colors" onClick={() => openFolder(null)}>
            {t('drive.allFiles')}
          </button>
          {crumbs.map((c) => (
            <React.Fragment key={c.id}>
              <ChevronRight size={12} className="text-fg-faint flex-shrink-0" />
              <button
                className="hover:text-fg transition-colors truncate max-w-[160px]"
                title={c.name}
                onClick={() => openFolder(c.id)}
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
              <button className="flex items-center gap-3 flex-1 min-w-0 text-left" onClick={() => openFolder(f.id)}>
                <Folder size={18} className="text-info flex-shrink-0" />
                <span className="text-sm text-fg truncate" title={f.name}>
                  {f.name}
                </span>
              </button>
              {rowActions({ kind: 'folder', item: f })}
              <button
                onClick={() => setConfirm({ kind: 'folder', id: f.id, name: f.name })}
                className={`${iconButton} hover:text-danger`}
                title={t('common.delete')}
                aria-label={t('common.delete')}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {files.map((f) => {
            const previewable = drivePreviewKind(f) !== null;
            return (
              <div
                key={`fl${f.id}`}
                data-file-id={f.id}
                className={`group flex items-center gap-3 px-3 py-2.5 hover:bg-surface-muted transition-colors ${
                  previewFileId === f.id ? 'bg-primary-subtle' : ''
                }`}
              >
                <button
                  type="button"
                  className="flex flex-1 min-w-0 items-center gap-3 text-left"
                  onClick={() => (previewable ? setPreview(f) : void download(f))}
                  title={previewable ? t('drive.preview') : t('drive.download')}
                >
                  <FileText size={18} className="text-fg-muted flex-shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-fg truncate" title={f.name}>
                      {f.name}
                    </span>
                    <span className="block text-[11px] text-fg-faint">
                      {formatFileSize(f.size)} · {formatDate(f.created_at)}
                    </span>
                  </span>
                </button>
                <button
                  onClick={() => void download(f)}
                  className="p-1 rounded text-fg-faint hover:text-fg transition-colors"
                  title={t('drive.download')}
                  aria-label={t('drive.download')}
                >
                  <Download size={14} />
                </button>
                {rowActions({ kind: 'file', item: f })}
                <button
                  onClick={() => setConfirm({ kind: 'file', id: f.id, name: f.name })}
                  className={`${iconButton} hover:text-danger`}
                  title={t('common.delete')}
                  aria-label={t('common.delete')}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
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

      <DriveRenameDialog
        open={renaming !== null}
        initialName={renaming?.item.name ?? ''}
        onClose={() => setRenaming(null)}
        onSubmit={(name) => void onRename(name)}
      />

      <DriveMoveDialog
        open={moving !== null}
        owner={owner}
        name={moving?.item.name ?? ''}
        currentParentId={moving ? (moving.kind === 'file' ? moving.item.folder_id : moving.item.parent_id) : null}
        movingFolderId={moving?.kind === 'folder' ? moving.item.id : null}
        onClose={() => setMoving(null)}
        onSubmit={(destination) => void onMove(destination)}
      />

      <DriveFilePreview
        file={preview}
        onClose={() => {
          setPreview(null);
          onPreviewClose?.();
        }}
      />

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
