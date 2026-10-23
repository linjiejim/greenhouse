/**
 * Knowledge (知识库) — the team's shelf, mine, and documents shared with me; one folder level per
 * page (`?shelf=&folder=`), folders first, then documents. The native search bar searches every
 * document I can read (titles and content). At the top of a shelf: the documents I opened
 * recently, which also read offline (src/store/knowledge.ts). Read-only on the phone for now.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { listDocs, listKbFolders, searchDocs, type KbShelf } from '../../src/api/knowledge';
import type { ApiResult } from '../../src/api/client';
import { captureIdentity } from '../../src/data/identity';
import { shelfRows, positioned, type KbRow } from '../../src/data/kb-rows';
import { levelOf, pathTo } from '../../src/data/kb-tree';
import type { RecentDoc } from '../../src/data/recent-docs';
import { useResource } from '../../src/data/use-resource';
import { useT } from '../../src/lib/i18n';
import { plainText } from '../../src/lib/plain-text';
import { relativeTimeNow } from '../../src/lib/time-words';
import type { DriveFolder, KbDoc, KbSearchHit } from '../../src/shared/greenhouse-types';
import { recentDocs } from '../../src/store/knowledge';
import { makeStyles, space, useTheme } from '../../src/theme';
import { DirectorySearch, useDirectoryFilter } from '../../src/ui/directory-search';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListRow, ListSectionHeader } from '../../src/ui/list';
import { Segmented } from '../../src/ui/segmented';

type Shelf = KbShelf | 'shared';

export default function Knowledge() {
  const params = useLocalSearchParams<{ shelf?: string; folder?: string }>();
  const shelf: Shelf = params.shelf === 'personal' || params.shelf === 'shared' ? params.shelf : 'team';
  const folderId = params.folder && /^[0-9]+$/.test(params.folder) ? Number(params.folder) : null;
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const filter = useDirectoryFilter();
  const query = filter.query.trim();

  const load = useCallback(async (): Promise<ApiResult<{ folders: DriveFolder[]; docs: KbDoc[] }>> => {
    const [docs, folders] = await Promise.all([
      listDocs(shelf, captureIdentity()),
      shelf === 'shared' ? Promise.resolve({ ok: true as const, data: { folders: [] } }) : listKbFolders(shelf),
    ]);
    if (!docs.ok) return docs;
    if (!folders.ok) return folders;
    return { ok: true, data: { folders: folders.data.folders, docs: docs.data.docs } };
  }, [shelf]);
  const resource = useResource(load);

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

  const header =
    folderId == null && !hits ? (
      <Segmented
        value={shelf}
        onChange={(value) => router.setParams({ shelf: value })}
        options={(['team', 'personal', 'shared'] as const).map((value) => ({
          value,
          label: t(`knowledge.shelf.${value}`),
        }))}
        style={styles.segmented}
      />
    ) : null;

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
    <View style={styles.root}>
      <Stack.Screen options={{ title }} />
      <DirectorySearch filter={filter} />
      <FlatList<KbRow>
        contentInsetAdjustmentBehavior="automatic"
        data={rows}
        keyExtractor={(row) => row.key}
        ListHeaderComponent={header}
        refreshing={resource.loading && !!resource.data}
        onRefresh={() => void resource.refresh()}
        renderItem={({ item }) => {
          if (item.type === 'header') return <ListSectionHeader title={item.title} />;
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
              <ListRow
                title={item.folder.name}
                icon="folder"
                accessory="chevron"
                position={item.position}
                onPress={() =>
                  router.push({ pathname: '/knowledge', params: { shelf, folder: String(item.folder.id) } })
                }
              />
            );
          return (
            <ListRow
              title={item.title}
              subtitle={item.subtitle}
              icon="file"
              accessory="chevron"
              position={item.position}
              onPress={() => router.push({ pathname: '/knowledge/doc', params: { id: String(item.id) } })}
            />
          );
        }}
        ListEmptyComponent={empty}
        contentContainerStyle={styles.content}
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxxl },
  segmented: { marginHorizontal: space.margin, marginVertical: space.md },
  state: { paddingTop: space.xxxl },
  inline: { paddingTop: space.xl },
}));
