/**
 * 知识库 — the team's shelf, mine, and documents shared with me; one folder level per page in
 * this tab's stack (`?shelf=&folder=`), folders first, then documents, under a path bar that
 * jumps back to any level. A document opens as a sheet. The shelf (every folder and document) is
 * kept on the phone and shows at once, offline too; the documents opened recently top the shelf.
 * The native search bar searches every document I can read. + makes a folder or a document here;
 * a long press on a row offers new / rename / move / ask (src/library/library-row.tsx).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Text } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { listDocs, listKbFolders, searchDocs, type KbShelf } from '../../../src/api/knowledge';
import type { ApiResult } from '../../../src/api/client';
import { captureIdentity } from '../../../src/data/identity';
import { shelfRows, positioned, type KbRow } from '../../../src/data/kb-rows';
import { levelOf, pathTo } from '../../../src/data/kb-tree';
import { parseShelf, type Shelf } from '../../../src/data/kb-shelf';
import type { RecentDoc } from '../../../src/data/recent-docs';
import { useOfflineResource } from '../../../src/data/use-offline-resource';
import { useLibraryChanges } from '../../../src/library/changes';
import { LibraryRow } from '../../../src/library/library-row';
import { PathBar } from '../../../src/library/path-bar';
import { useLibraryActions } from '../../../src/library/use-library-actions';
import { useT } from '../../../src/lib/i18n';
import { plainText } from '../../../src/lib/plain-text';
import { relativeTimeNow } from '../../../src/lib/time-words';
import type { KbSearchHit } from '../../../src/shared/greenhouse-types';
import { useOpenObject } from '../../../src/shell/open-object';
import { recentDocs } from '../../../src/store/knowledge';
import { makeStyles, space, typo, useTheme } from '../../../src/theme';
import { DirectorySearch, useDirectoryFilter } from '../../../src/ui/directory-search';
import { EmptyState, LoadingState } from '../../../src/ui/empty';
import { SectionHeader } from '../../../src/ui/list';
import { Segmented } from '../../../src/ui/segmented';
import { toolbarIcon } from '../../../src/ui/toolbar-icon';
import { objectId } from '../../../src/lib/object-id';

type ShelfName = KbShelf | 'shared';

export default function Knowledge() {
  const params = useLocalSearchParams<{ shelf?: string; folder?: string }>();
  const shelf: ShelfName = params.shelf === 'personal' || params.shelf === 'shared' ? params.shelf : 'team';
  const folderId = objectId(params.folder);
  const t = useT();
  const router = useRouter();
  const openObject = useOpenObject();
  const actions = useLibraryActions();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const filter = useDirectoryFilter();
  const query = filter.query.trim();
  const writable = shelf !== 'shared';
  const owner: KbShelf = shelf === 'personal' ? 'personal' : 'team';

  const load = useCallback(async (): Promise<ApiResult<Shelf>> => {
    const [docs, folders] = await Promise.all([
      listDocs(shelf, captureIdentity()),
      shelf === 'shared' ? Promise.resolve({ ok: true as const, data: { folders: [] } }) : listKbFolders(shelf),
    ]);
    if (!docs.ok) return docs;
    if (!folders.ok) return folders;
    // bodies stay out of the shelf (and its offline copy); a document sheet reads its own
    return { ok: true, data: { folders: folders.data.folders, docs: docs.data.docs.map((doc) => ({ ...doc, content_markdown: '' })) } };
  }, [shelf]);
  const resource = useOfflineResource(`kb-shelf-${shelf}`, load, parseShelf);

  // a write anywhere in the tree reloads this level
  const version = useLibraryChanges((s) => s.version);
  const { refresh } = resource;
  useEffect(() => {
    if (version) void refresh();
  }, [version, refresh]);

  const [recent, setRecent] = useState<RecentDoc[]>([]);
  useEffect(() => {
    if (folderId == null) void recentDocs().then(setRecent);
  }, [folderId, resource.data]);

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
    return shelfRows({
      atTop: folderId == null,
      recent,
      level: resource.data ? levelOf(resource.data.folders, resource.data.docs, folderId) : null,
      loading: resource.loading,
      titles: { recent: t('knowledge.recent'), shelf: t(`knowledge.shelf.${shelf}`) },
      docSubtitle: (doc) => relativeTimeNow(doc.updated_at),
    });
  }, [hits, resource.data, resource.loading, folderId, recent, shelf, t]);

  // back to a level of the path: pop the pages above it in this tab
  const pick = (index: number) => {
    const levels = path.length - index;
    if (levels > 0 && router.canDismiss()) router.dismiss(levels);
    else router.setParams({ folder: index === 0 ? undefined : String(path[index - 1]!.id) });
  };

  const header = hits ? null : folderId == null ? (
    <>
      <Segmented
        value={shelf}
        onChange={(value) => router.setParams({ shelf: value })}
        options={(['team', 'personal', 'shared'] as const).map((value) => ({ value, label: t(`knowledge.shelf.${value}`) }))}
        style={styles.segmented}
      />
      {resource.offline ? <Text style={styles.offline}>{t('common.savedCopy')}</Text> : null}
    </>
  ) : (
    <PathBar levels={[t(`knowledge.shelf.${shelf}`), ...path.map((folder) => folder.name)]} onPick={pick} />
  );

  const empty = !resource.data ? (
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
    <EmptyState icon="book" title={t(hits ? 'common.noMatches' : 'knowledge.empty')} style={styles.state} />
  );

  return (
    <>
      <Stack.Screen options={{ title }} />
      <DirectorySearch filter={filter} />
      {writable ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Menu icon={toolbarIcon('plus')} accessibilityLabel={t('library.new')}>
            <Stack.Toolbar.MenuAction icon="folder.badge.plus" onPress={() => void actions.newFolder(owner, folderId)}>
              {t('library.newFolder')}
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="doc.badge.plus" onPress={() => actions.newDoc(owner, folderId)}>
              {t('library.newDoc')}
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar>
      ) : null}
      <FlatList<KbRow>
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        data={rows}
        keyExtractor={(row) => row.key}
        ListHeaderComponent={header}
        refreshing={resource.loading && !!resource.data}
        onRefresh={() => void resource.refresh()}
        renderItem={({ item }) => {
          if (item.type === 'header') return <SectionHeader title={item.title} />;
          if (item.type === 'loading') return <LoadingState style={styles.inline} />;
          if (item.type === 'failed')
            return (
              <EmptyState
                icon="alert"
                title={t('knowledge.loadFailed')}
                message={t('knowledge.offlineRecent')}
                onRetry={() => void resource.refresh()}
                style={styles.inline}
              />
            );
          if (item.type === 'folder')
            return (
              <LibraryRow
                item={{ kind: 'folder', id: item.folder.id, name: item.folder.name, shelf: owner, scope: 'kb' }}
                position={item.position}
                readOnly={!writable}
                onPress={() => router.push({ pathname: '/knowledge', params: { shelf, folder: String(item.folder.id) } })}
              />
            );
          return (
            <LibraryRow
              item={{ kind: 'doc', id: item.id, name: item.title, shelf: owner, subtitle: item.subtitle }}
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
  offline: { ...typo.footnote, color: c.secondaryLabel, paddingHorizontal: space.margin + space.xs, paddingBottom: space.sm },
  state: { paddingTop: space.xxxl },
  inline: { paddingTop: space.xl },
}));
