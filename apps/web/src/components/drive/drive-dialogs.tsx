/**
 * Rename and move dialogs for DriveBrowser.
 *
 * A move only offers folders of the same cabinet (the server refuses anything
 * else anyway): the browser lists the cabinet's folders once, flat, and builds
 * the indented tree here. A folder can never be moved into itself or below
 * itself, so those branches are left out.
 */

import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Input, Spinner } from '../ui';
import { Folder } from '../../lib/icons';
import { listDriveFolders, type DriveFolder, type DriveOwner } from '../../lib/api/drive';
import { useT } from '../../lib/i18n';

export function DriveRenameDialog({
  open,
  initialName,
  onClose,
  onSubmit,
}: {
  open: boolean;
  initialName: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState(initialName);
  useEffect(() => {
    if (open) setName(initialName);
  }, [initialName, open]);
  const trimmed = name.trim();
  const submit = () => {
    if (trimmed && trimmed !== initialName) onSubmit(trimmed);
  };
  return (
    <Dialog open={open} onClose={onClose} title={t('drive.rename')} size="sm">
      <div className="space-y-3">
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label={t('drive.newName')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={submit} disabled={!trimmed || trimmed === initialName}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

interface TreeRow {
  folder: DriveFolder;
  depth: number;
}

/** Depth-first rows of the folder tree, skipping `excludeId` and everything below it. */
export function folderTreeRows(folders: readonly DriveFolder[], excludeId: string | null): TreeRow[] {
  const children = new Map<string | null, DriveFolder[]>();
  for (const folder of folders) {
    const list = children.get(folder.parent_id) ?? [];
    list.push(folder);
    children.set(folder.parent_id, list);
  }
  const rows: TreeRow[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const folder of children.get(parentId) ?? []) {
      if (folder.id === excludeId) continue;
      rows.push({ folder, depth });
      if (depth < 32) walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

export function DriveMoveDialog({
  open,
  owner,
  name,
  currentParentId,
  movingFolderId,
  onClose,
  onSubmit,
}: {
  open: boolean;
  owner: DriveOwner;
  /** What is being moved, for the title. */
  name: string;
  currentParentId: string | null;
  /** Set when a folder is moved: it and its subtree are not valid targets. */
  movingFolderId: string | null;
  onClose: () => void;
  onSubmit: (targetFolderId: string | null) => void;
}) {
  const t = useT();
  const [folders, setFolders] = useState<DriveFolder[] | null>(null);
  const [target, setTarget] = useState<string | null>(currentParentId);

  useEffect(() => {
    if (!open) return;
    setTarget(currentParentId);
    setFolders(null);
    let cancelled = false;
    listDriveFolders(owner, 'all')
      .then((rows) => !cancelled && setFolders(rows))
      .catch(() => !cancelled && setFolders([]));
    return () => {
      cancelled = true;
    };
    // owner is stable per browser instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentParentId]);

  const rows = useMemo(() => folderTreeRows(folders ?? [], movingFolderId), [folders, movingFolderId]);
  const option = (id: string | null, label: string, depth: number) => (
    <button
      key={id ?? 'root'}
      type="button"
      onClick={() => setTarget(id)}
      aria-pressed={target === id}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
        target === id ? 'bg-primary-subtle text-primary-fg-strong' : 'text-fg-secondary hover:bg-surface-muted'
      }`}
      style={{ paddingLeft: `${8 + depth * 16}px` }}
    >
      <Folder size={14} className="flex-shrink-0 text-info" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </button>
  );

  return (
    <Dialog open={open} onClose={onClose} title={t('drive.moveTitle', { name })} size="md">
      <div className="space-y-3">
        <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-edge p-1">
          {folders === null ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : (
            <>
              {option(null, t('drive.allFiles'), 0)}
              {rows.map((row) => option(row.folder.id, row.folder.name, row.depth + 1))}
            </>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={() => onSubmit(target)} disabled={target === currentParentId}>
            {t('drive.moveHere')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
