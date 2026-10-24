/**
 * What the long-press menu of a knowledge or 云盘 row does: new folder or document inside a
 * folder, rename, move (the folder picker sheet, app/move.tsx), delete, ask the assistant. Every
 * write is bound to the identity that started it, reports a failure with alertError and, once it
 * lands, reloads every list of the tree (./changes.ts).
 */

import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { createFolder, deleteFile, deleteFolder, updateFile, updateFolder, type FilesShelf } from '../api/drive';
import { deleteDoc, updateDoc } from '../api/knowledge';
import type { ApiResult } from '../api/client';
import { captureIdentity } from '../data/identity';
import { putHandoff } from '../lib/handoff';
import { useT } from '../lib/i18n';
import { alertError, confirmAction, promptText } from '../ui/dialogs';
import { notifySuccess } from '../ui/haptics';
import { toast } from '../ui/toast';
import { libraryChanged, type Movable } from './changes';

export function useLibraryActions() {
  const t = useT();
  const router = useRouter();

  const run = useCallback(
    async <T,>(write: () => Promise<ApiResult<T>>, failed: string, done?: string): Promise<T | null> => {
      const current = captureIdentity();
      const result = await write();
      if (!current()) return null;
      if (!result.ok) {
        alertError(failed, result.message || undefined);
        return null;
      }
      notifySuccess();
      if (done) toast(done, 'check');
      libraryChanged();
      return result.data;
    },
    [],
  );

  const newFolder = useCallback(
    async (shelf: FilesShelf, parentId: number | null) => {
      const name = await promptText({ title: t('library.newFolder'), placeholder: t('library.folderName') });
      if (!name) return;
      await run(() => createFolder(shelf, parentId, name.slice(0, 120)), t('library.failed'));
    },
    [run, t],
  );

  const rename = useCallback(
    async (item: Movable) => {
      const name = await promptText({ title: t('library.rename'), defaultValue: item.name });
      if (!name || name === item.name) return;
      const value = name.slice(0, 200);
      await run<unknown>(
        () =>
          item.kind === 'doc'
            ? updateDoc(item.id, { title: value })
            : item.kind === 'file'
              ? updateFile(item.id, { name: value })
              : updateFolder(item.id, { name: value }),
        t('library.failed'),
      );
    },
    [run, t],
  );

  const move = useCallback(
    (item: Movable) => {
      router.push({ pathname: '/move', params: { k: putHandoff('move', item) } });
    },
    [router],
  );

  const remove = useCallback(
    async (item: Movable) => {
      const ok = await confirmAction({
        title: t('library.deleteTitle', { name: item.name }),
        message: item.kind === 'folder' ? t('library.deleteFolderHint') : t('library.deleteHint'),
        confirmLabel: t('library.delete'),
        destructive: true,
      });
      if (!ok) return;
      const current = captureIdentity();
      const result: ApiResult<unknown> =
        item.kind === 'doc' ? await deleteDoc(item.id) : item.kind === 'file' ? await deleteFile(item.id) : await deleteFolder(item.id);
      if (!current()) return;
      if (!result.ok) {
        alertError(t(result.status === 409 ? 'library.notEmpty' : 'library.failed'), result.status === 409 ? undefined : result.message || undefined);
        return;
      }
      notifySuccess();
      libraryChanged();
    },
    [t],
  );

  const newDoc = useCallback(
    (shelf: FilesShelf, folderId: number | null) => {
      router.push({ pathname: '/doc-new', params: { shelf, ...(folderId ? { folder: String(folderId) } : {}) } });
    },
    [router],
  );

  return { newFolder, newDoc, rename, move, remove, run };
}
