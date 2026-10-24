/**
 * 云盘 — the team's files, mine, and (with the `tables` feature) the table bases: one segmented
 * control at the top, one folder level per page in this tab's stack (`?shelf=&folder=`) under a
 * path bar that jumps back to any level. A file opens as a sheet (Quick Look with share). + uploads
 * from Photos, the camera or Files into the folder on screen, or makes a folder; a long press on a
 * row renames, moves or deletes it (src/library/library-row.tsx). The native search bar searches
 * names on both shelves.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { breadcrumb, listLevel, searchCabinet, type FilesShelf } from '../../../src/api/drive';
import { listBases } from '../../../src/api/tables';
import { noAccess } from '../../../src/data/access';
import { captureIdentity } from '../../../src/data/identity';
import type { RecentFile } from '../../../src/data/recent-items';
import { useResource } from '../../../src/data/use-resource';
import { pick, uploadAll, type UploadFrom } from '../../../src/files/upload';
import { libraryChanged, useLibraryChanges } from '../../../src/library/changes';
import { LibraryRow, type LibraryItem } from '../../../src/library/library-row';
import { PathBar } from '../../../src/library/path-bar';
import { useLibraryActions } from '../../../src/library/use-library-actions';
import { formatBytes } from '../../../src/lib/format';
import { useT } from '../../../src/lib/i18n';
import { relativeTimeNow } from '../../../src/lib/time-words';
import type { DriveFolder, TableBase } from '../../../src/shared/greenhouse-types';
import { hasTables } from '../../../src/shell/modules';
import { useOpenObject } from '../../../src/shell/open-object';
import { useAuth } from '../../../src/store/auth';
import { recentFiles, rememberFile } from '../../../src/store/offline';
import { makeStyles, space, useTheme } from '../../../src/theme';
import { alertError } from '../../../src/ui/dialogs';
import { DirectorySearch, useDirectoryFilter } from '../../../src/ui/directory-search';
import { EmptyState, LoadingState } from '../../../src/ui/empty';
import { notifySuccess } from '../../../src/ui/haptics';
import { Row, SectionHeader, rowPosition, type RowPosition } from '../../../src/ui/list';
import { Segmented } from '../../../src/ui/segmented';
import { toast } from '../../../src/ui/toast';
import { toolbarIcon } from '../../../src/ui/toolbar-icon';
import { objectId } from '../../../src/lib/object-id';

type View = FilesShelf | 'tables';

type Item =
  | { key: string; type: 'header'; title: string }
  | { key: string; type: 'failed' }
  | { key: string; type: 'entry'; entry: LibraryItem; position: RowPosition }
  | { key: string; type: 'base'; base: TableBase; position: RowPosition };

export default function Drive() {
  const params = useLocalSearchParams<{ shelf?: string; folder?: string; view?: string }>();
  const t = useT();
  const router = useRouter();
  const openObject = useOpenObject();
  const actions = useLibraryActions();
  const user = useAuth((s) => s.user);
  const tablesOn = hasTables(user);
  const view: View = params.view === 'tables' && tablesOn ? 'tables' : params.shelf === 'personal' ? 'personal' : 'team';
  const shelf: FilesShelf = view === 'personal' ? 'personal' : 'team';
  const folderId = objectId(params.folder);
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const filter = useDirectoryFilter();
  const query = filter.query.trim();
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    if (view === 'tables') {
      const bases = await listBases();
      return bases.ok
        ? { ok: true as const, data: { bases: bases.data.bases.filter((base) => !base.archived_at), folders: [], files: [] } }
        : bases;
    }
    const level = await listLevel(shelf, folderId);
    return level.ok ? { ok: true as const, data: { bases: [] as TableBase[], ...level.data } } : level;
  }, [view, shelf, folderId]);
  const resource = useResource(load);
  const version = useLibraryChanges((s) => s.version);
  const { refresh } = resource;
  useEffect(() => {
    if (version) void refresh();
  }, [version, refresh]);

  const [recent, setRecent] = useState<RecentFile[]>([]);
  useEffect(() => {
    if (folderId == null && view !== 'tables') void recentFiles().then(setRecent);
  }, [folderId, view, resource.data, resource.error]);

  const [path, setPath] = useState<DriveFolder[]>([]);
  useEffect(() => {
    if (folderId == null) {
      setPath([]);
      return;
    }
    let alive = true;
    void breadcrumb(folderId).then((result) => {
      if (alive && result.ok) setPath(result.data.folders);
    });
    return () => {
      alive = false;
    };
  }, [folderId, version]);

  const open = useCallback(
    (entry: LibraryItem) => {
      if (entry.kind === 'folder') {
        router.push({ pathname: '/drive', params: { shelf: entry.shelf, folder: String(entry.id) } });
        return;
      }
      const file = resource.data?.files.find((f) => f.id === entry.id);
      if (file) void rememberFile(file, entry.shelf);
      openObject({ kind: 'file', id: entry.id });
    },
    [resource.data, router, openObject],
  );

  const [hits, setHits] = useState<Item[] | null>(null);
  useEffect(() => {
    if (!query) {
      setHits(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void searchCabinet(query.slice(0, 200)).then((result) => {
        if (!alive) return;
        if (!result.ok) {
          setHits([]);
          return;
        }
        const all: LibraryItem[] = [
          ...result.data.folders.map((f): LibraryItem => ({ kind: 'folder', id: f.id, name: f.name, shelf: f.shelf, scope: 'drive' })),
          ...result.data.files.map(
            (f): LibraryItem => ({
              kind: 'file',
              id: f.id,
              name: f.name,
              shelf: f.shelf,
              subtitle: `${t(`files.shelf.${f.shelf}`)} · ${formatBytes(f.size)}`,
            }),
          ),
        ];
        setHits(all.map((entry, i) => ({ key: `h-${entry.kind}-${entry.id}`, type: 'entry', entry, position: rowPosition(i, all.length) })));
      });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, t]);

  const rows = useMemo((): Item[] => {
    if (hits) return hits;
    if (view === 'tables') {
      const bases = resource.data?.bases ?? [];
      return bases.map((base, i) => ({ key: `b-${base.id}`, type: 'base', base, position: rowPosition(i, bases.length) }));
    }
    const out: Item[] = [];
    const lately = folderId == null ? recent.slice(0, 5) : [];
    if (lately.length) {
      out.push({ key: 'h-recent', type: 'header', title: t('files.recent') });
      lately.forEach((f, i) =>
        out.push({
          key: `r-${f.id}`,
          type: 'entry',
          entry: { kind: 'file', id: f.id, name: f.name, shelf: f.shelf, subtitle: `${formatBytes(f.size)} · ${relativeTimeNow(f.updated_at)}` },
          position: rowPosition(i, lately.length),
        }),
      );
    }
    if (!resource.data) {
      if (out.length && !resource.loading) out.push({ key: 'failed', type: 'failed' });
      return out;
    }
    if (out.length) out.push({ key: 'h-shelf', type: 'header', title: t(`files.shelf.${shelf}`) });
    const { folders, files } = resource.data;
    const count = folders.length + files.length;
    folders.forEach((f, i) =>
      out.push({ key: `f-${f.id}`, type: 'entry', entry: { kind: 'folder', id: f.id, name: f.name, shelf, scope: 'drive' }, position: rowPosition(i, count) }),
    );
    files.forEach((f, i) =>
      out.push({
        key: `d-${f.id}`,
        type: 'entry',
        entry: {
          kind: 'file',
          id: f.id,
          name: f.name,
          shelf,
          contentType: f.content_type,
          subtitle: `${formatBytes(f.size)} · ${relativeTimeNow(f.updated_at)}`,
        },
        position: rowPosition(folders.length + i, count),
      }),
    );
    return out;
  }, [hits, view, resource.data, resource.loading, shelf, recent, folderId, t]);

  const upload = async (from: UploadFrom) => {
    // the whole upload belongs to whoever opened the picker, on this station
    const current = captureIdentity();
    let sources;
    try {
      sources = await pick(from);
    } catch {
      alertError(t('files.cameraDenied'));
      return;
    }
    if (!sources.length || !current()) return;
    setUploading(true);
    const result = await uploadAll({ shelf, folderId }, sources, current);
    setUploading(false);
    if (result.stopped || !current()) return;
    if (result.done) {
      notifySuccess();
      toast(t('files.uploaded', { n: result.done }), 'check');
      libraryChanged();
    }
    if (result.failed) alertError(t('files.uploadFailed', { n: result.failed }), result.error || undefined);
  };

  const pickLevel = (index: number) => {
    const levels = path.length - index;
    if (levels > 0 && router.canDismiss()) router.dismiss(levels);
    else router.setParams({ folder: index === 0 ? undefined : String(path[index - 1]!.id) });
  };

  const views: View[] = tablesOn ? ['team', 'personal', 'tables'] : ['team', 'personal'];
  const header = hits ? null : folderId == null ? (
    <>
      <Segmented
        value={view}
        onChange={(value) => router.setParams(value === 'tables' ? { view: 'tables' } : { view: undefined, shelf: value })}
        options={views.map((value) => ({ value, label: value === 'tables' ? t('nav.tables') : t(`files.shelf.${value}`) }))}
        style={styles.segmented}
      />
      {uploading ? <LoadingState style={styles.uploading} /> : null}
    </>
  ) : (
    <>
      <PathBar levels={[t(`files.shelf.${shelf}`), ...path.map((folder) => folder.name)]} onPick={pickLevel} />
      {uploading ? <LoadingState style={styles.uploading} /> : null}
    </>
  );

  const empty =
    !resource.data && !hits ? (
      resource.loading ? (
        <LoadingState style={styles.state} />
      ) : view === 'tables' && noAccess(resource.error) ? (
        <EmptyState icon="hand" title={t('tables.noAccess')} message={t('tables.noAccessHint')} style={styles.state} />
      ) : (
        <EmptyState icon="alert" title={t('files.loadFailed')} onRetry={() => void resource.refresh()} style={styles.state} />
      )
    ) : view === 'tables' && !hits ? (
      <EmptyState icon="table" title={t('tables.empty')} message={t('tables.emptyHint')} style={styles.state} />
    ) : (
      <EmptyState
        icon="folder"
        title={t(hits ? 'common.noMatches' : 'files.empty')}
        message={hits ? undefined : t('files.emptyHint')}
        style={styles.state}
      />
    );

  return (
    <>
      <Stack.Screen options={{ title: folderId != null ? (path[path.length - 1]?.name ?? '') : t('nav.files') }} />
      <DirectorySearch filter={filter} />
      {view !== 'tables' ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Menu icon={toolbarIcon('plus')} accessibilityLabel={t('library.new')} disabled={uploading}>
            <Stack.Toolbar.MenuAction icon="photo.on.rectangle" onPress={() => void upload('photos')}>
              {t('files.fromPhotos')}
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="camera" onPress={() => void upload('camera')}>
              {t('files.fromCamera')}
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="folder" onPress={() => void upload('files')}>
              {t('files.fromFiles')}
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="folder.badge.plus" onPress={() => void actions.newFolder(shelf, folderId)}>
              {t('library.newFolder')}
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar>
      ) : null}
      <FlatList<Item>
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        data={rows}
        keyExtractor={(row) => row.key}
        refreshing={resource.loading && !!resource.data}
        onRefresh={() => void resource.refresh()}
        ListHeaderComponent={header}
        renderItem={({ item }) =>
          item.type === 'header' ? (
            <SectionHeader title={item.title} />
          ) : item.type === 'failed' ? (
            <EmptyState
              icon="alert"
              title={t('files.loadFailed')}
              message={t('files.offlineRecent')}
              onRetry={() => void resource.refresh()}
              style={styles.inline}
            />
          ) : item.type === 'base' ? (
            <Row
              title={item.base.name}
              subtitle={item.base.description || undefined}
              icon="table"
              value={item.base.role ? t(`tables.role.${item.base.role}`) : undefined}
              accessory="chevron"
              position={item.position}
              onPress={() => router.push({ pathname: '/drive/base', params: { id: String(item.base.id) } })}
            />
          ) : (
            <LibraryRow item={item.entry} position={item.position} onPress={() => open(item.entry)} />
          )
        }
        ListEmptyComponent={empty}
        contentContainerStyle={styles.content}
      />
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxxl },
  segmented: { marginHorizontal: space.margin, marginVertical: space.md },
  uploading: { paddingVertical: space.md },
  state: { paddingTop: space.xxxl },
  inline: { paddingTop: space.xl },
}));
