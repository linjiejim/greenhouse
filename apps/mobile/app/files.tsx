/**
 * Files (档案库) — the knowledge cabinet: the team's shelf and mine, one folder level per page
 * (`?shelf=&folder=`; `&file=` opens that file's preview once, for deep links). The native search
 * bar searches names on both shelves. The + menu uploads from Photos, the camera or Files into
 * the folder on screen; a file opens in Quick Look (app/file-preview.tsx) with share.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { breadcrumb, listLevel, searchCabinet, type FilesShelf } from '../src/api/drive';
import { useResource } from '../src/data/use-resource';
import { pick, uploadAll, type UploadFrom } from '../src/files/upload';
import { useT } from '../src/lib/i18n';
import { relativeTimeNow } from '../src/lib/time-words';
import { formatBytes } from '../src/lib/format';
import type { DriveFolder } from '../src/shared/greenhouse-types';
import { makeStyles, space, useTheme } from '../src/theme';
import { alertError } from '../src/ui/dialogs';
import { DirectorySearch, useDirectoryFilter } from '../src/ui/directory-search';
import { EmptyState, LoadingState } from '../src/ui/empty';
import { notifySuccess } from '../src/ui/haptics';
import { ListRow, type RowPosition } from '../src/ui/list';
import { Segmented } from '../src/ui/segmented';
import { toast } from '../src/ui/toast';
import { toolbarIcon } from '../src/ui/toolbar-icon';

type Row =
  | { key: string; type: 'folder'; id: number; name: string; shelf: FilesShelf; position: RowPosition }
  | { key: string; type: 'file'; id: number; name: string; subtitle: string; position: RowPosition };

const position = (index: number, count: number): RowPosition =>
  count === 1 ? 'only' : index === 0 ? 'first' : index === count - 1 ? 'last' : 'middle';

export default function Files() {
  const params = useLocalSearchParams<{ shelf?: string; folder?: string; file?: string }>();
  const shelf: FilesShelf = params.shelf === 'personal' ? 'personal' : 'team';
  const folderId = params.folder && /^[0-9]+$/.test(params.folder) ? Number(params.folder) : null;
  const openFileId = params.file && /^[0-9]+$/.test(params.file) ? Number(params.file) : null;
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const filter = useDirectoryFilter();
  const query = filter.query.trim();
  const [uploading, setUploading] = useState(false);

  const load = useCallback(() => listLevel(shelf, folderId), [shelf, folderId]);
  const resource = useResource(load);

  const [folder, setFolder] = useState<DriveFolder | null>(null);
  useEffect(() => {
    if (folderId == null) return;
    void breadcrumb(folderId).then((result) => {
      if (result.ok) setFolder(result.data.folders[result.data.folders.length - 1] ?? null);
    });
  }, [folderId]);

  // a deep link to a file opens its preview once
  const opened = useRef(false);
  useEffect(() => {
    if (!openFileId || opened.current || !resource.data) return;
    opened.current = true;
    const file = resource.data.files.find((entry) => entry.id === openFileId);
    router.push({ pathname: '/file-preview', params: { id: String(openFileId), name: file?.name ?? '' } });
  }, [openFileId, resource.data, router]);

  const [hits, setHits] = useState<Row[] | null>(null);
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
        const all = [
          ...result.data.folders.map((f) => ({ kind: 'folder' as const, ...f })),
          ...result.data.files.map((f) => ({ kind: 'file' as const, ...f })),
        ];
        setHits(
          all.map((hit, index) =>
            hit.kind === 'folder'
              ? { key: `hf-${hit.id}`, type: 'folder', id: hit.id, name: hit.name, shelf: hit.shelf, position: position(index, all.length) }
              : {
                  key: `hd-${hit.id}`,
                  type: 'file',
                  id: hit.id,
                  name: hit.name,
                  subtitle: `${t(`files.shelf.${hit.shelf}`)} · ${formatBytes(hit.size)}`,
                  position: position(index, all.length),
                },
          ),
        );
      });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, t]);

  const rows = useMemo((): Row[] => {
    if (hits) return hits;
    if (!resource.data) return [];
    const { folders, files } = resource.data;
    const count = folders.length + files.length;
    return [
      ...folders.map((f, i): Row => ({ key: `f-${f.id}`, type: 'folder', id: f.id, name: f.name, shelf, position: position(i, count) })),
      ...files.map(
        (f, i): Row => ({
          key: `d-${f.id}`,
          type: 'file',
          id: f.id,
          name: f.name,
          subtitle: `${formatBytes(f.size)} · ${relativeTimeNow(f.updated_at)}`,
          position: position(folders.length + i, count),
        }),
      ),
    ];
  }, [hits, resource.data, shelf]);

  const upload = async (from: UploadFrom) => {
    let sources;
    try {
      sources = await pick(from);
    } catch {
      alertError(t('files.cameraDenied'));
      return;
    }
    if (!sources.length) return;
    setUploading(true);
    const result = await uploadAll({ shelf, folderId }, sources);
    setUploading(false);
    if (result.done) {
      notifySuccess();
      toast(t('files.uploaded', { n: result.done }), 'check');
      void resource.refresh();
    }
    if (result.failed) alertError(t('files.uploadFailed', { n: result.failed }), result.error || undefined);
  };

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: folderId != null ? (folder?.name ?? '') : t('nav.files') }} />
      <DirectorySearch filter={filter} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon={toolbarIcon('plus')} accessibilityLabel={t('files.upload')} disabled={uploading}>
          <Stack.Toolbar.MenuAction icon="photo.on.rectangle" onPress={() => void upload('photos')}>
            {t('files.fromPhotos')}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="camera" onPress={() => void upload('camera')}>
            {t('files.fromCamera')}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="folder" onPress={() => void upload('files')}>
            {t('files.fromFiles')}
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <FlatList<Row>
        contentInsetAdjustmentBehavior="automatic"
        data={rows}
        keyExtractor={(row) => row.key}
        refreshing={resource.loading && !!resource.data}
        onRefresh={() => void resource.refresh()}
        ListHeaderComponent={
          <>
            {folderId == null && !hits ? (
              <Segmented
                value={shelf}
                onChange={(value) => router.setParams({ shelf: value })}
                options={(['team', 'personal'] as const).map((value) => ({ value, label: t(`files.shelf.${value}`) }))}
                style={styles.segmented}
              />
            ) : null}
            {uploading ? <LoadingState style={styles.uploading} /> : null}
          </>
        }
        renderItem={({ item }) =>
          item.type === 'folder' ? (
            <ListRow
              title={item.name}
              icon="folder"
              accessory="chevron"
              position={item.position}
              onPress={() => router.push({ pathname: '/files', params: { shelf: item.shelf, folder: String(item.id) } })}
            />
          ) : (
            <ListRow
              title={item.name}
              subtitle={item.subtitle}
              icon="file"
              position={item.position}
              onPress={() => router.push({ pathname: '/file-preview', params: { id: String(item.id), name: item.name } })}
            />
          )
        }
        ListEmptyComponent={
          !resource.data && !hits ? (
            resource.loading ? (
              <LoadingState style={styles.state} />
            ) : (
              <EmptyState icon="alert" title={t('files.loadFailed')} onRetry={() => void resource.refresh()} style={styles.state} />
            )
          ) : (
            <EmptyState icon="folder" title={t(hits ? 'common.noMatches' : 'files.empty')} message={hits ? undefined : t('files.emptyHint')} style={styles.state} />
          )
        }
        contentContainerStyle={styles.content}
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxxl },
  segmented: { marginHorizontal: space.margin, marginVertical: space.md },
  uploading: { paddingVertical: space.md },
  state: { paddingTop: space.xxxl },
}));
