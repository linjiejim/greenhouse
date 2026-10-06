/**
 * Knowledge list (知识库) — a pushed page with a collapsing large title and the
 * system search bar in its default iOS 26 place (the bottom toolbar, same as
 * 项目; server-side search, debounced). The
 * scope filter (全部 / 团队 / 个人 / 共享 → the API's `?visibility=`) is a
 * native segmented control at the top of the list content.
 *
 * Rows are Mail/Notes-style (src/knowledge/doc-row.tsx); tap opens the doc,
 * long-press opens its system context menu: 打开 · 预览 (bottom-sheet peek) ·
 * 编辑 (editors only) · 修改历史 — the two menus are built once, and rows are
 * full-width so the menu gets the window width up front. Every route gets the
 * slug + the authoritative id. Pull to refresh; the list also refetches
 * silently on every focus so edits and restores made deeper in the stack show
 * up on return. First load = `LoadingState`, a failed load = `EmptyState` with
 * 重试 (a failed silent refetch keeps the rows on screen). Creating documents
 * stays web-only.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, RefreshControl, View, useWindowDimensions } from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { canEditDoc, listDocs, type KnowledgeDoc, type KnowledgeScope } from '../../src/api/knowledge';
import { DocRow } from '../../src/knowledge/doc-row';
import { useT } from '../../src/lib/i18n';
import { makeStyles, space, useTheme } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { NativeMenu, menuSections, type MenuItem } from '../../src/ui/menu';
import { Segmented } from '../../src/ui/segmented';

type DocAction = 'open' | 'preview' | 'edit' | 'history';

export default function KnowledgeList() {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const { width: windowWidth } = useWindowDimensions();
  const headerHeight = useHeaderHeight();
  const { bottom: bottomInset } = useSafeAreaInsets();

  const [docs, setDocs] = useState<KnowledgeDoc[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<KnowledgeScope>('all');
  const [refreshing, setRefreshing] = useState(false);

  // The current query lives in a ref so focus refetches / debounced searches
  // always read the latest values; `seq` drops responses that arrive late.
  const query = useRef<{ search: string; scope: KnowledgeScope }>({ search: '', scope: 'all' });
  const seq = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const { search: q, scope: s } = query.current;
    const rows = await listDocs({ search: q.trim() || undefined, scope: s });
    if (mine !== seq.current) return;
    if (rows) {
      setDocs(rows);
      setFailed(false);
    } else {
      setFailed(true);
      setDocs((prev) => prev ?? []);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current);
    },
    [],
  );

  const onSearch = useCallback(
    (text: string) => {
      setSearch(text);
      query.current.search = text;
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => void load(), 300);
    },
    [load],
  );

  const onScope = useCallback(
    (s: KnowledgeScope) => {
      if (s === query.current.scope) return;
      setScope(s);
      query.current.scope = s;
      setDocs(null);
      if (debounce.current) clearTimeout(debounce.current);
      void load();
    },
    [load],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const retry = useCallback(() => {
    setDocs(null);
    setFailed(false);
    void load();
  }, [load]);

  const onAction = useCallback(
    (action: DocAction, doc: KnowledgeDoc) => {
      const id = String(doc.id);
      switch (action) {
        case 'open':
          router.push({ pathname: '/knowledge/[slug]', params: { slug: doc.slug, id, title: doc.title } });
          return;
        case 'preview':
          router.push({ pathname: '/peek/doc/[slug]', params: { slug: doc.slug, id } });
          return;
        case 'edit':
          router.push({ pathname: '/knowledge/edit', params: { slug: doc.slug, id } });
          return;
        case 'history':
          router.push({ pathname: '/knowledge/versions', params: { slug: doc.slug, id } });
          return;
      }
    },
    [router],
  );

  // Two menus cover every row: with 编辑 (editors) and without (readers).
  const menus = useMemo(() => {
    const build = (editable: boolean): MenuItem[] =>
      menuSections([
        [
          { id: 'open', title: t('common.open'), icon: 'file' },
          { id: 'preview', title: t('knowledge.preview'), icon: 'eye' },
        ],
        [
          ...(editable ? [{ id: 'edit', title: t('knowledge.edit'), icon: 'pen' } as const] : []),
          { id: 'history', title: t('knowledge.history'), icon: 'activity' },
        ],
      ]);
    return { editor: build(true), reader: build(false) };
  }, [t]);

  const searching = search.trim().length > 0;
  const list = docs ?? [];

  // Loading / failed / empty states fill the space under the scope control and
  // center in it: while the list is empty the content container grows to the
  // list's frame, minus the bar insets the scroll view adds above and below
  // (otherwise the center lands that much too low). "No results" stays at the
  // top, above the keyboard of the search being typed.
  const empty =
    docs === null ? (
      <LoadingState />
    ) : failed ? (
      <EmptyState
        icon="alert"
        title={t('knowledge.loadFailed')}
        message={t('knowledge.loadFailedHint')}
        onRetry={retry}
        style={styles.centered}
      />
    ) : searching ? (
      <EmptyState icon="search" title={t('knowledge.emptySearch')} message={t('knowledge.emptySearchHint')} />
    ) : (
      <EmptyState
        icon="books"
        title={scope === 'all' ? t('knowledge.empty') : t('knowledge.emptyScope')}
        message={scope === 'shared' ? t('knowledge.emptySharedHint') : t('knowledge.emptyHint')}
        style={styles.centered}
      />
    );

  return (
    <>
      <Stack.Screen options={{ title: t('knowledge.title') }} />
      <Stack.SearchBar
        placeholder={t('knowledge.searchPlaceholder')}
        autoCapitalize="none"
        tintColor={hex.accent}
        onChangeText={(e) => onSearch(e.nativeEvent.text)}
        onCancelButtonPress={() => onSearch('')}
      />
      <FlatList
        data={list}
        keyExtractor={(d) => String(d.id)}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.content,
          list.length === 0 && { flexGrow: 1, paddingBottom: headerHeight + bottomInset },
        ]}
        ListHeaderComponent={
          <View style={styles.header}>
            <Segmented<KnowledgeScope>
              value={scope}
              onChange={onScope}
              options={[
                { value: 'all', label: t('knowledge.scopeAll') },
                { value: 'team', label: t('knowledge.scopeTeam') },
                { value: 'private', label: t('knowledge.scopeMine') },
                { value: 'shared', label: t('knowledge.scopeShared') },
              ]}
            />
          </View>
        }
        ListEmptyComponent={empty}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={hex.accent} />}
        renderItem={({ item, index }) => (
          <NativeMenu
            trigger="longPress"
            width={windowWidth}
            items={canEditDoc(item) ? menus.editor : menus.reader}
            onSelect={(id) => onAction(id as DocAction, item)}
          >
            <DocRow doc={item} last={index === list.length - 1} onPress={() => onAction('open', item)} />
          </NativeMenu>
        )}
      />
    </>
  );
}

const useStyles = makeStyles(() => ({
  content: { paddingBottom: space.xxxl },
  centered: { flexGrow: 1, justifyContent: 'center' },
  header: { paddingHorizontal: space.margin, paddingTop: space.xs, paddingBottom: space.md },
}));
