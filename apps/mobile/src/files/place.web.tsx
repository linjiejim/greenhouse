import React, { useCallback, useEffect, useState } from 'react';
import { calendarDateLabel } from '../lib/time-words';
import { Icon } from '../ui/core';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import Phone from './phone-screen';
import TablesPlace from '../plugins/tables/place.web';
import { listLevel, listFolders, breadcrumb, uploadBatch, searchCabinet, type FilesShelf } from '../api/drive';
import { api } from '../api/client';
import { getAccessToken } from '../api/token-storage';
import { useResource } from '../data/use-resource';
import { captureIdentity } from '../data/identity';
import { recentFiles } from '../store/offline';
import { PlaceSecondary } from '../shell/place-secondary.web';
import { useOpenObject } from '../shell/open-object';
import { Place, PlaceRow, PlaceSidebar, PlaceEmpty } from '../ui/place.web';
import { FileDrop, pickFile } from '../ui/file-drop.web';
import { useLibraryActions } from '../library/use-library-actions';
import { libraryChanged, useLibraryChanges } from '../library/changes';
import { formatBytes } from '../lib/format';
import { useT } from '../lib/i18n';
import { alertError } from '../ui/dialogs';
export default function DrivePlace() {
  const { width } = useWindowDimensions();
  const { view } = useLocalSearchParams<{ view?: string }>();
  return width < 760 ? <Phone /> : view === 'tables' ? <TablesPlace /> : <DriveDesktop />;
}
function DriveDesktop() {
  const t = useT(),
    router = useRouter(),
    open = useOpenObject(),
    actions = useLibraryActions();
  const params = useLocalSearchParams<{ shelf?: string; folder?: string }>();
  const shelf: FilesShelf = params.shelf === 'personal' ? 'personal' : 'team';
  const folder = params.folder ?? null;
  const [query, setQuery] = useState(''),
    [recent, setRecent] = useState(false),
    [uploading, setUploading] = useState(false),
    [grid, setGrid] = useState(false),
    [selected, setSelected] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (query) {
      const result = await searchCabinet(query);
      return result.ok
        ? {
            ok: true as const,
            data: {
              folders: result.data.folders.map((f) => ({
                ...f,
                created_by: '',
                scope: 'kb',
                visibility: shelf === 'personal' ? 'private' : 'team',
                created_at: '',
                updated_at: '',
              })),
              files: result.data.files.map((f) => ({
                ...f,
                folder_id: null,
                content_type: null,
                created_by: '',
                scope: 'kb',
                visibility: shelf === 'personal' ? 'private' : 'team',
                created_at: '',
                updated_at: '',
              })),
            },
          }
        : result;
    }
    if (recent) {
      const files = await recentFiles();
      return {
        ok: true as const,
        data: {
          folders: [],
          files: files.map((f) => ({
            ...f,
            folder_id: null,
            created_by: '',
            scope: 'kb',
            visibility: f.shelf === 'personal' ? 'private' : 'team',
            created_at: '',
          })),
        },
      };
    }
    return listLevel(shelf, folder);
  }, [shelf, folder, query, recent]);
  const data = useResource<{
    folders: { id: string; name: string; updated_at: string }[];
    files: { id: string; name: string; updated_at: string; size: number; uploaded_by?: string | null }[];
  }>(load);
  const path = useResource(
    useCallback(
      () => (folder ? breadcrumb(folder) : Promise.resolve({ ok: true as const, data: { folders: [] } })),
      [folder],
    ),
  );
  const root = useResource(useCallback(() => listFolders(shelf), [shelf]));
  const version = useLibraryChanges((s) => s.version);
  const { refresh } = data;
  const rootRefresh = root.refresh;
  useEffect(() => {
    if (version) {
      void refresh();
      void rootRefresh();
    }
  }, [version, refresh, rootRefresh]);
  const choose = (s: FilesShelf, f: string | null = null) => {
    setRecent(false);
    router.setParams({ shelf: s, folder: f ?? undefined });
  };
  const upload = async (files: File[]) => {
    const current = captureIdentity();
    if (!files.length || uploading) return;
    setUploading(true);
    const urls = files.map((f) => URL.createObjectURL(f));
    try {
      const r = await uploadBatch(
        { shelf, folderId: folder },
        files.map((f, i) => ({ uri: urls[i], name: f.name, size: f.size, type: f.type })),
        async (url, uri, headers) => {
          const blob = await fetch(uri).then((r) => r.blob());
          return (await api(url, { method: 'PUT', headers, body: blob })).status;
        },
        () => {
          const token = getAccessToken();
          return token ? `Bearer ${token}` : null;
        },
        current,
      );
      if (!current()) return;
      if (r.done) libraryChanged();
      if (r.failed) alertError(t('library.failed'), r.error);
    } finally {
      urls.forEach((url) => URL.revokeObjectURL(url));
      if (current()) setUploading(false);
    }
  };
  const entries = [
    ...(data.data?.folders ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      kind: 'folder' as const,
      created_by: null,
      updated_at: f.updated_at,
      size: null,
    })),
    ...(data.data?.files ?? []).map((f) => ({ ...f, created_by: f.uploaded_by, kind: 'file' as const })),
  ];
  return (
    <>
      <PlaceSecondary>
        <PlaceSidebar
          title={t('nav.files')}
          query={query}
          onQuery={setQuery}
          action={
            <button aria-label={t('places.upload')} onClick={() => void pickFile().then(upload)}>
              <Icon name="upload" size={18} />
            </button>
          }
        >
          <div data-place-list>
            <PlaceRow title={t('files.shelf.recent')} icon="clock" selected={recent} onOpen={() => setRecent(true)} />
            <PlaceRow
              title={t('files.shelf.team')}
              icon="person"
              selected={!recent && shelf === 'team'}
              onOpen={() => choose('team')}
            />
            <PlaceRow
              title={t('files.shelf.personal')}
              icon="person"
              selected={!recent && shelf === 'personal'}
              onOpen={() => choose('personal')}
            />
            <h3>
              {t(`files.shelf.${shelf}`)} · {t('places.directory')}
            </h3>
            {(() => {
              const tree = (parent: string | null, seen: string[] = []): React.ReactNode =>
                seen.length > 30
                  ? null
                  : root.data?.folders
                      .filter((f) => f.parent_id === parent && !seen.includes(f.id))
                      .map((f) => (
                        <div key={f.id}>
                          <PlaceRow
                            title={f.name}
                            icon="folder"
                            selected={folder === f.id}
                            onOpen={() => choose(shelf, f.id)}
                          />
                          <div style={{ paddingLeft: 16 }}>{tree(f.id, [...seen, f.id])}</div>
                        </div>
                      ));
              return tree(null);
            })()}
          </div>
        </PlaceSidebar>
      </PlaceSecondary>
      <Place
        title={[t(`files.shelf.${shelf}`), ...(path.data?.folders.map((f) => f.name) ?? [])].join(' › ')}
        actions={
          <>
            <button aria-label={t('places.grid')} aria-pressed={grid} onClick={() => setGrid(!grid)}>
              <Icon name={grid ? 'list' : 'grid'} size={18} />
            </button>
            <button aria-label={t('library.newFolder')} onClick={() => void actions.newFolder(shelf, folder)}>
              <Icon name="folderPlus" size={18} />
            </button>
            <button className="gh-primary" disabled={uploading} onClick={() => void pickFile().then(upload)}>
              {t('places.upload')}
            </button>
          </>
        }
      >
        <FileDrop onFiles={(files) => void upload(files)}>
          <div className="gh-place-scroll gh-drive-list" data-place-list data-testid="drive-list">
            {!grid ? (
              <div className="gh-drive-head">
                <span>{t('places.name')}</span>
                <span>{t('places.owner')}</span>
                <span>{t('places.modified')}</span>
                <span>{t('places.size')}</span>
              </div>
            ) : null}
            <div
              style={
                grid
                  ? {
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))',
                      gap: 12,
                      paddingTop: 12,
                    }
                  : undefined
              }
            >
              {entries.map((entry) => (
                <div key={entry.id} className={grid ? '' : 'gh-drive-entry'}>
                  <PlaceRow
                    title={entry.name}
                    icon={entry.kind === 'folder' ? 'folder' : 'file'}
                    selected={selected === entry.id}
                    onOpen={() => {
                      setSelected(entry.id);
                      if (entry.kind === 'folder') choose(shelf, entry.id);
                      else open({ kind: 'file', id: entry.id });
                    }}
                    items={[
                      { id: 'rename', title: t('library.rename'), icon: 'pen' },
                      { id: 'move', title: t('library.move'), icon: 'folder' },
                      { id: 'delete', title: t('library.delete'), icon: 'trash', destructive: true },
                    ]}
                    onSelect={(id) => {
                      const movable = { ...entry, shelf, scope: 'drive' as const };
                      if (id === 'rename') void actions.rename(movable);
                      if (id === 'move') actions.move(movable);
                      if (id === 'delete') void actions.remove(movable);
                    }}
                  />
                  {!grid ? (
                    <>
                      <small>{entry.created_by}</small>
                      <small>{entry.updated_at ? calendarDateLabel(entry.updated_at) : ''}</small>
                      <small>{entry.size === null ? '—' : formatBytes(entry.size)}</small>
                    </>
                  ) : null}
                </div>
              ))}
            </div>
            {!entries.length ? (
              <PlaceEmpty loading={data.loading} error={data.error?.message} retry={() => void refresh()} />
            ) : null}
          </div>
        </FileDrop>
      </Place>
    </>
  );
}
