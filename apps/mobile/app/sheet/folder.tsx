/**
 * A folder as an object sheet (`/sheet/folder?id=&scope=kb|drive&shelf=`), opened from a link or
 * a search hit: its subfolders, then its documents (知识库) or files (云盘). A subfolder or an
 * item opens as a sheet stacked on this one; long press offers the same actions as in the tabs.
 */

import React, { useCallback, useEffect, useMemo } from 'react';
import { FlatList } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { breadcrumb, listLevel, type FilesShelf } from '../../src/api/drive';
import { listDocs, listKbFolders } from '../../src/api/knowledge';
import type { ApiResult } from '../../src/api/client';
import { captureIdentity } from '../../src/data/identity';
import { levelOf } from '../../src/data/kb-tree';
import { useResource } from '../../src/data/use-resource';
import { useLibraryChanges } from '../../src/library/changes';
import { LibraryRow, type LibraryItem } from '../../src/library/library-row';
import { formatBytes } from '../../src/lib/format';
import { useT } from '../../src/lib/i18n';
import { relativeTimeNow } from '../../src/lib/time-words';
import { useOpenObject } from '../../src/shell/open-object';
import { makeStyles, space, useTheme } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { rowPosition } from '../../src/ui/list';
import { SheetScreen } from '../../src/ui/screen';

interface Level {
  name: string;
  items: LibraryItem[];
}

export default function FolderSheet() {
  const params = useLocalSearchParams<{ id?: string; scope?: string; shelf?: string }>();
  const id = params.id && /^[0-9]+$/.test(params.id) ? Number(params.id) : null;
  const scope = params.scope === 'kb' ? 'kb' : 'drive';
  const shelf: FilesShelf = params.shelf === 'personal' ? 'personal' : 'team';
  const t = useT();
  const openObject = useOpenObject();
  const { colors: c } = useTheme();
  const styles = useStyles(c);

  const load = useCallback(async (): Promise<ApiResult<Level>> => {
    if (id == null) return { ok: false, status: 404, code: 'not_found', message: '' };
    const crumbs = await breadcrumb(id);
    if (!crumbs.ok) return crumbs;
    const name = crumbs.data.folders.at(-1)?.name ?? '';
    if (scope === 'drive') {
      const level = await listLevel(shelf, id);
      if (!level.ok) return level;
      return {
        ok: true,
        data: {
          name,
          items: [
            ...level.data.folders.map((f): LibraryItem => ({ kind: 'folder', id: f.id, name: f.name, shelf, scope })),
            ...level.data.files.map(
              (f): LibraryItem => ({
                kind: 'file',
                id: f.id,
                name: f.name,
                shelf,
                contentType: f.content_type,
                subtitle: `${formatBytes(f.size)} · ${relativeTimeNow(f.updated_at)}`,
              }),
            ),
          ],
        },
      };
    }
    const [docs, folders] = await Promise.all([listDocs(shelf, captureIdentity()), listKbFolders(shelf)]);
    if (!docs.ok) return docs;
    if (!folders.ok) return folders;
    const level = levelOf(folders.data.folders, docs.data.docs, id);
    return {
      ok: true,
      data: {
        name,
        items: [
          ...level.folders.map((f): LibraryItem => ({ kind: 'folder', id: f.id, name: f.name, shelf, scope })),
          ...level.docs.map((d): LibraryItem => ({ kind: 'doc', id: d.id, name: d.title, shelf, subtitle: relativeTimeNow(d.updated_at) })),
        ],
      },
    };
  }, [id, scope, shelf]);
  const resource = useResource(load);
  const version = useLibraryChanges((s) => s.version);
  const { refresh } = resource;
  useEffect(() => {
    if (version) void refresh();
  }, [version, refresh]);

  const items = useMemo(() => resource.data?.items ?? [], [resource.data]);
  const open = (item: LibraryItem) => {
    if (item.kind === 'folder') openObject({ kind: 'folder', scope, shelf, id: item.id });
    else if (item.kind === 'doc') openObject({ kind: 'doc', id: item.id });
    else openObject({ kind: 'file', id: item.id, name: item.name });
  };

  return (
    <>
      <SheetScreen title={resource.data?.name ?? t('links.folder')} />
      <FlatList<LibraryItem>
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        data={items}
        keyExtractor={(item) => `${item.kind}-${item.id}`}
        renderItem={({ item, index }) => <LibraryRow item={item} position={rowPosition(index, items.length)} onPress={() => open(item)} />}
        ListEmptyComponent={
          !resource.data ? (
            resource.loading ? (
              <LoadingState style={styles.state} />
            ) : (
              <EmptyState icon="folder" title={t(resource.error?.status === 404 || resource.error?.status === 403 ? 'library.folderGone' : 'files.loadFailed')} onRetry={resource.error?.status === 404 ? undefined : () => void resource.refresh()} style={styles.state} />
            )
          ) : (
            <EmptyState icon="folder" title={t('files.empty')} style={styles.state} />
          )
        }
        contentContainerStyle={styles.content}
      />
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingTop: space.md, paddingBottom: space.xxxl },
  state: { paddingTop: space.xxxl },
}));
