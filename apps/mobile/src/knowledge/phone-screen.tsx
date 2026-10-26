import { ScreenActions } from '../ui/screen-actions';
/**
 * 知识库 — 最近 (the documents I opened on this phone, the first segment and where the page opens),
 * the team's shelf, mine, and documents shared with me; one folder level per page in this place's
 * stack (`?shelf=&folder=`), folders first, then documents, under a path bar that jumps back to
 * any level. Every document row is one line: title, and its date at the trailing edge. A document
 * opens as a sheet. A shelf (every folder and document) is kept on the phone and shows at once,
 * offline too; 最近 needs no station at all (src/store/knowledge.ts). The native search bar
 * searches every document I can read. + is always there: it makes a folder or a document on the
 * shelf on screen (on 最近 and 共享给我, in 我的); a long press on a row offers new / rename / move /
 * ask (src/library/library-row.tsx).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Text } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { listDocs, listKbFolders, searchDocs, type KbShelf } from '../api/knowledge';
import type { ApiResult } from '../api/client';
import { captureIdentity } from '../data/identity';
import { positioned, recentRows, shelfRows, type KbRow } from '../data/kb-rows';
import { levelOf, pathTo } from '../data/kb-tree';
import { parseShelf, type Shelf } from '../data/kb-shelf';
import type { RecentDoc } from '../data/recent-docs';
import { useOfflineResource } from '../data/use-offline-resource';
import { useLibraryChanges } from '../library/changes';
import { LibraryRow } from '../library/library-row';
import { PathBar } from '../library/path-bar';
import { useLibraryActions } from '../library/use-library-actions';
import { useT } from '../lib/i18n';
import { plainText } from '../lib/plain-text';
import { relativeTimeNow } from '../lib/time-words';
import type { KbSearchHit } from '../shared/greenhouse-types';
import { useOpenObject } from '../shell/open-object';
import { recentDocs } from '../store/knowledge';
import { onOfflineChanged } from '../store/offline-events';
import { makeStyles, space, typo, useTheme } from '../theme';
import { DirectorySearch, useDirectoryFilter } from '../ui/directory-search';
import { SidebarToolbar } from '../ui/sidebar';
import { useWholePageDrawerSwipe } from '../ui/place-swipe';
import { EmptyState, LoadingState } from '../ui/empty';
import { usePullRefresh } from '../ui/refresh';
import { Segmented } from '../ui/segmented';

import { objectId } from '../lib/object-id';

type ShelfName = KbShelf | 'shared';
type Segment = ShelfName | 'recent';

export default function Knowledge() {
  const params = useLocalSearchParams<{ shelf?: string; folder?: string }>();
  const folderId = objectId(params.folder);
  // the page opens on 最近; a folder always belongs to a shelf
  const segment: Segment =
    params.shelf === 'personal' || params.shelf === 'shared' || params.shelf === 'team'
      ? params.shelf
      : params.shelf === 'recent' || folderId == null
        ? 'recent'
        : 'team';
  const showingRecent = segment === 'recent' && folderId == null;
  // 最近 reads no shelf; the team's loads behind it, the next one most members open
  const shelf: ShelfName = segment === 'recent' ? 'team' : segment;
  const t = useT();
  // a rightward swipe anywhere on the page opens the sidebar, as on home
  useWholePageDrawerSwipe();
  const router = useRouter();
  const openObject = useOpenObject();
  const actions = useLibraryActions();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const filter = useDirectoryFilter();
  const query = filter.query.trim();
  const writable = !showingRecent && shelf !== 'shared';
  const owner: KbShelf = shelf === 'personal' ? 'personal' : 'team';
  // where + puts things: the shelf on screen, or 我的 where that shelf takes no writes
  const target: { shelf: KbShelf; folder: string | null } = writable
    ? { shelf: owner, folder: folderId }
    : { shelf: 'personal', folder: null };

  const load = useCallback(async (): Promise<ApiResult<Shelf>> => {
    const [docs, folders] = await Promise.all([
      listDocs(shelf, captureIdentity()),
      shelf === 'shared' ? Promise.resolve({ ok: true as const, data: { folders: [] } }) : listKbFolders(shelf),
    ]);
    if (!docs.ok) return docs;
    if (!folders.ok) return folders;
    // bodies stay out of the shelf (and its offline copy); a document sheet reads its own
    return {
      ok: true,
      data: { folders: folders.data.folders, docs: docs.data.docs.map((doc) => ({ ...doc, content_markdown: '' })) },
    };
  }, [shelf]);
  const resource = useOfflineResource(`kb-shelf-${shelf}`, load, parseShelf);
  const pull = usePullRefresh(resource.refresh);
  const busy = resource.loading && !!resource.data && !pull.refreshing;

  // a write anywhere in the tree reloads this level
  const version = useLibraryChanges((s) => s.version);
  const { refresh } = resource;
  useEffect(() => {
    if (version) void refresh();
  }, [version, refresh]);

  // 最近: the list src/store/knowledge.ts keeps, read again whenever a document sheet updates it
  const [recent, setRecent] = useState<RecentDoc[]>([]);
  const readRecent = useCallback(() => void recentDocs().then(setRecent), []);
  useEffect(() => {
    readRecent();
    return onOfflineChanged((kind) => {
      if (kind === 'kb-recent') readRecent();
    });
  }, [readRecent]);

  const [hits, setHits] = useState<KbSearchHit[] | null>(null);
  useEffect(() => {
    if (!query) {
      setHits(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void searchDocs(query.slice(0, 200)).then((result) => {
        if (alive) setHits(result.ok ? result.data.results : []);
      });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);

  const path = useMemo(() => pathTo(resource.data?.folders ?? [], folderId), [resource.data, folderId]);
  const title = path.length ? path[path.length - 1]!.name : t('nav.knowledge');

  const rows = useMemo((): KbRow[] => {
    if (hits) {
      return positioned(hits, (hit, position) => ({
        key: `hit-${hit.id}`,
        type: 'doc',
        id: hit.id,
        title: hit.title,
        subtitle: plainText(hit.snippet || hit.summary, { oneLine: true }) || undefined,
        position,
      }));
    }
    if (showingRecent) return recentRows(recent, (entry) => relativeTimeNow(new Date(entry.openedAt).toISOString()));
    return shelfRows(resource.data ? levelOf(resource.data.folders, resource.data.docs, folderId) : null, (doc) =>
      relativeTimeNow(doc.updated_at),
    );
  }, [hits, resource.data, folderId, recent, showingRecent]);

  // back to a level of the path: pop the pages above it in this tab
  const pick = (index: number) => {
    const levels = path.length - index;
    if (levels > 0 && router.canDismiss()) router.dismiss(levels);
    else router.setParams({ folder: index === 0 ? undefined : String(path[index - 1]!.id) });
  };

  const header = hits ? null : folderId == null ? (
    <>
      <Segmented
        value={segment}
        onChange={(value) => router.setParams({ shelf: value })}
        options={(['recent', 'team', 'personal', 'shared'] as const).map((value) => ({
          value,
          label: t(`knowledge.shelf.${value}`),
        }))}
        style={styles.segmented}
      />
      {resource.offline && !showingRecent ? <Text style={styles.offline}>{t('common.savedCopy')}</Text> : null}
    </>
  ) : (
    <PathBar levels={[t(`knowledge.shelf.${shelf}`), ...path.map((folder) => folder.name)]} onPick={pick} />
  );

  const empty = showingRecent ? (
    <EmptyState icon="clock" title={t('knowledge.recentEmpty')} style={styles.state} />
  ) : !resource.data ? (
    resource.loading ? (
      <LoadingState style={styles.state} />
    ) : (
      <EmptyState
        icon="alert"
        title={t('knowledge.loadFailed')}
        message={recent.length ? t('knowledge.offlineRecent') : undefined}
        onRetry={() => void resource.refresh()}
        style={styles.state}
      />
    )
  ) : (
    <EmptyState
      icon="book"
      title={t(hits ? 'common.noMatches' : 'knowledge.empty')}
      message={hits ? undefined : t('knowledge.emptyHint')}
      style={styles.state}
    />
  );

  return (
    <>
      <Stack.Screen options={{ title }} />
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
          {
            id: 'action-1',
            icon: 'plus' as const,
            label: t('library.new'),
            menu: [
              {
                id: 'action-2',
                icon: 'folderPlus' as const,
                label: t('library.newFolder'),
                onPress: () => void actions.newFolder(target.shelf, target.folder),
              },
              {
                id: 'action-3',
                icon: 'docPlus' as const,
                label: t('library.newDoc'),
                onPress: () => actions.newDoc(target.shelf, target.folder),
              },
            ],
            onPress: () => {},
          },
        ]}
      />
      <FlatList<KbRow>
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        data={rows}
        keyExtractor={(row) => row.key}
        ListHeaderComponent={header}
        refreshing={showingRecent ? false : pull.refreshing}
        onRefresh={showingRecent ? readRecent : pull.onRefresh}
        renderItem={({ item }) => {
          if (item.type === 'folder')
            return (
              <LibraryRow
                item={{ kind: 'folder', id: item.folder.id, name: item.folder.name, shelf: owner, scope: 'kb' }}
                position={item.position}
                readOnly={!writable}
                onPress={() =>
                  router.push({ pathname: '/knowledge', params: { shelf, folder: String(item.folder.id) } })
                }
              />
            );
          return (
            <LibraryRow
              item={{
                kind: 'doc',
                id: item.id,
                name: item.title,
                shelf: owner,
                subtitle: item.subtitle,
                date: item.date,
              }}
              position={item.position}
              readOnly={!writable}
              onPress={() => openObject({ kind: 'doc', id: item.id })}
            />
          );
        }}
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
  offline: {
    ...typo.footnote,
    color: c.secondaryLabel,
    paddingHorizontal: space.margin + space.xs,
    paddingBottom: space.sm,
  },
  state: { paddingTop: space.xxxl },
}));
