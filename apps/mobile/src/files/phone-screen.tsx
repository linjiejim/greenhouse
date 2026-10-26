import { useStationManifest } from '../plugins/store';
import { builtinVisible } from '../plugins/manifest';
import { ScreenActions } from '../ui/screen-actions';
/**
 * 云盘 — 最近 (the files I opened on this phone, the first segment and where the page opens, like
 * 知识库), the team's files, mine, and (with the `tables` feature) the table bases: one segmented
 * control at the top, one folder level per page in this tab's stack (`?shelf=&folder=`) under a
 * path bar that jumps back to any level. A file opens as a sheet (Quick Look with share). + is
 * always there: it uploads from Photos, the camera or Files into the folder on screen (on 最近,
 * into 我的), or makes a folder; a long press on a row renames, moves or deletes it
 * (src/library/library-row.tsx). The native search bar searches names on both shelves.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { breadcrumb, listLevel, searchCabinet, type FilesShelf } from '../api/drive';
import { createBase, listBases } from '../api/tables';
import { noAccess } from '../data/access';
import { captureIdentity } from '../data/identity';
import type { RecentFile } from '../data/recent-items';
import { useResource } from '../data/use-resource';
import { pick, uploadAll, type UploadFrom } from '../files/upload';
import { libraryChanged, useLibraryChanges } from '../library/changes';
import { LibraryRow, type LibraryItem } from '../library/library-row';
import { PathBar } from '../library/path-bar';
import { useLibraryActions } from '../library/use-library-actions';
import { formatBytes } from '../lib/format';
import { useT } from '../lib/i18n';
import { relativeTimeNow } from '../lib/time-words';
import type { DriveFolder, TableBase } from '../shared/greenhouse-types';
import { hasTables } from '../shell/modules';
import { useOpenObject } from '../shell/open-object';
import { useAuth } from '../store/auth';
import { recentFiles, rememberFile } from '../store/offline';
import { makeStyles, space, useTheme } from '../theme';
import { alertError, promptText } from '../ui/dialogs';
import { DirectorySearch, useDirectoryFilter } from '../ui/directory-search';
import { SidebarToolbar } from '../ui/sidebar';
import { useWholePageDrawerSwipe } from '../ui/place-swipe';
import { EmptyState, LoadingState } from '../ui/empty';
import { notifySuccess } from '../ui/haptics';
import { Row, rowPosition, type RowPosition } from '../ui/list';
import { usePullRefresh } from '../ui/refresh';
import { Segmented } from '../ui/segmented';
import { toast } from '../ui/toast';

import { objectId } from '../lib/object-id';

type View = FilesShelf | 'tables' | 'recent';

type Item =
  | { key: string; type: 'entry'; entry: LibraryItem; position: RowPosition }
  | { key: string; type: 'base'; base: TableBase; position: RowPosition };

export default function Drive() {
  const params = useLocalSearchParams<{ shelf?: string; folder?: string; view?: string }>();
  const t = useT();
  // a rightward swipe anywhere on the page opens the sidebar, as on home
  useWholePageDrawerSwipe();
  const router = useRouter();
  const openObject = useOpenObject();
  const actions = useLibraryActions();
  const user = useAuth((s) => s.user);
  const manifest = useStationManifest((s) => s.data);
  const tablesOn = builtinVisible(manifest, 'tables', hasTables(user));
  const folderId = objectId(params.folder);
  // the page opens on 最近; a folder always belongs to a shelf
  const view: View =
    params.view === 'tables' && tablesOn
      ? 'tables'
      : params.shelf === 'personal' || params.shelf === 'team'
        ? params.shelf
        : folderId == null
          ? 'recent'
          : 'team';
  const showingRecent = view === 'recent';
  // 最近 has no shelf of its own: + puts new files in 我的, which every member can write
  const shelf: FilesShelf = view === 'team' ? 'team' : 'personal';
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const filter = useDirectoryFilter();
  const query = filter.query.trim();
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    if (view === 'recent') return { ok: true as const, data: { bases: [] as TableBase[], folders: [], files: [] } };
    if (view === 'tables') {
      const bases = await listBases();
      return bases.ok
        ? {
            ok: true as const,
            data: { bases: bases.data.bases.filter((base) => !base.archived_at), folders: [], files: [] },
          }
        : bases;
    }
    const level = await listLevel(shelf, folderId);
    return level.ok ? { ok: true as const, data: { bases: [] as TableBase[], ...level.data } } : level;
  }, [view, shelf, folderId]);
  const resource = useResource(load);
  const pull = usePullRefresh(resource.refresh);
  const busy = resource.loading && !!resource.data && !pull.refreshing;
  const version = useLibraryChanges((s) => s.version);
  const { refresh } = resource;
  useEffect(() => {
    if (version) void refresh();
  }, [version, refresh]);

  const [recent, setRecent] = useState<RecentFile[]>([]);
  useEffect(() => {
    if (view === 'recent') void recentFiles().then(setRecent);
  }, [view, version]);

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
          ...result.data.folders.map(
            (f): LibraryItem => ({ kind: 'folder', id: f.id, name: f.name, shelf: f.shelf, scope: 'drive' }),
          ),
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
        setHits(
          all.map((entry, i) => ({
            key: `h-${entry.kind}-${entry.id}`,
            type: 'entry',
            entry,
            position: rowPosition(i, all.length),
          })),
        );
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
      return bases.map((base, i) => ({
        key: `b-${base.id}`,
        type: 'base',
        base,
        position: rowPosition(i, bases.length),
      }));
    }
    if (view === 'recent') {
      return recent.map((f, i) => ({
        key: `r-${f.id}`,
        type: 'entry',
        entry: {
          kind: 'file',
          id: f.id,
          name: f.name,
          shelf: f.shelf,
          subtitle: `${t(`files.shelf.${f.shelf}`)} · ${formatBytes(f.size)} · ${relativeTimeNow(f.updated_at)}`,
        },
        position: rowPosition(i, recent.length),
      }));
    }
    const out: Item[] = [];
    if (!resource.data) return out;
    const { folders, files } = resource.data;
    const count = folders.length + files.length;
    folders.forEach((f, i) =>
      out.push({
        key: `f-${f.id}`,
        type: 'entry',
        entry: { kind: 'folder', id: f.id, name: f.name, shelf, scope: 'drive' },
        position: rowPosition(i, count),
      }),
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
  }, [hits, view, resource.data, shelf, recent, t]);

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

  const newBase = async () => {
    const name = (await promptText({ title: t('tables.newBase'), placeholder: t('tables.newBaseName') }))?.trim();
    if (!name) return;
    const current = captureIdentity();
    const made = await createBase(name.slice(0, 200));
    if (!current()) return;
    if (!made.ok) {
      alertError(t('tables.createFailed'), made.message || undefined);
      return;
    }
    notifySuccess();
    void resource.refresh();
    router.push({ pathname: '/drive/base', params: { id: String(made.data.base.id) } });
  };

  const pickLevel = (index: number) => {
    const levels = path.length - index;
    if (levels > 0 && router.canDismiss()) router.dismiss(levels);
    else router.setParams({ folder: index === 0 ? undefined : String(path[index - 1]!.id) });
  };

  const views: View[] = tablesOn ? ['recent', 'team', 'personal', 'tables'] : ['recent', 'team', 'personal'];
  const header = hits ? null : folderId == null ? (
    <>
      <Segmented
        value={view}
        onChange={(value) =>
          router.setParams(
            value === 'tables' ? { view: 'tables', shelf: undefined } : { view: undefined, shelf: value },
          )
        }
        options={views.map((value) => ({
          value,
          label: value === 'tables' ? t('nav.tables') : t(`files.shelf.${value}`),
        }))}
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
    showingRecent && !hits ? (
      <EmptyState icon="clock" title={t('files.recentEmpty')} message={t('files.offlineRecent')} style={styles.state} />
    ) : !resource.data && !hits ? (
      resource.loading ? (
        <LoadingState style={styles.state} />
      ) : view === 'tables' && noAccess(resource.error) ? (
        <EmptyState icon="hand" title={t('tables.noAccess')} message={t('tables.noAccessHint')} style={styles.state} />
      ) : (
        <EmptyState
          icon="alert"
          title={t('files.loadFailed')}
          onRetry={() => void resource.refresh()}
          style={styles.state}
        />
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
      <SidebarToolbar />
      <ScreenActions
        placement={'right'}
        actions={[
          {
            id: 'refresh',
            icon: 'refresh',
            label: t('common.loading'),
            onPress: () => {},
            busy: busy && !showingRecent,
          },
          ...(view !== 'tables'
            ? [
                {
                  id: 'action-1',
                  icon: 'plus' as const,
                  label: t('library.new'),
                  disabled: uploading,
                  menu: [
                    {
                      id: 'action-2',
                      icon: 'photos' as const,
                      label: t('files.fromPhotos'),
                      onPress: () => void upload('photos'),
                    },
                    {
                      id: 'action-3',
                      icon: 'camera' as const,
                      label: t('files.fromCamera'),
                      onPress: () => void upload('camera'),
                    },
                    {
                      id: 'action-4',
                      icon: 'folder' as const,
                      label: t('files.fromFiles'),
                      onPress: () => void upload('files'),
                    },
                    {
                      id: 'action-5',
                      icon: 'folderPlus' as const,
                      label: t('library.newFolder'),
                      onPress: () => void actions.newFolder(shelf, folderId),
                    },
                  ],
                  onPress: () => {},
                },
              ]
            : [
                ...(!noAccess(resource.error)
                  ? [
                      {
                        id: 'action-6',
                        icon: 'plus' as const,
                        label: t('tables.newBase'),
                        onPress: () => void newBase(),
                      },
                    ]
                  : []),
              ]),
        ]}
      />
      <FlatList<Item>
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        data={rows}
        keyExtractor={(row) => row.key}
        refreshing={showingRecent ? false : pull.refreshing}
        onRefresh={showingRecent ? () => void recentFiles().then(setRecent) : pull.onRefresh}
        ListHeaderComponent={header}
        renderItem={({ item }) =>
          item.type === 'base' ? (
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
}));
