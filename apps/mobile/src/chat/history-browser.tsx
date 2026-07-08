/**
 * HistoryBrowser — the shared conversation-browsing body: a title search
 * (server-side ?q=), a tag filter bar (server-side ?tag_id=), and an
 * infinite-scroll list of <HistoryRow>s with long-press actions (tag / delete).
 * Reused by both hosts:
 *   - <HistorySheet> — the top-bar popup (88% sheet; `inSheet` uses the
 *     bottom-sheet-aware text input);
 *   - app/history/index.tsx — the standalone history screen.
 * The host owns the tag-manager sheet + its trigger button (header placement
 * differs) and passes `onManageTags`.
 */

import React, { useState } from 'react';
import { Alert, type AlertButton, FlatList, StyleSheet, TextInput, View } from 'react-native';
import { deleteSession } from '../api/sessions';
import type { Session } from '../shared/greenhouse-types';
import { useT } from '../lib/i18n';
import { font, makeStyles, radius, useTheme } from '../theme';
import { BottomSheetTextInput, EmptyState, Icon, Skeleton, Spinner, Touchable } from '../ui';
import { HistoryRow, useSessions } from './history-list';
import { TagFilter } from './tag-filter';
import { TagSelectorSheet } from './tag-selector-sheet';

export interface OpenConversation {
  id: string;
  title: string;
  readOnly: boolean;
}

export function HistoryBrowser({
  enabled,
  onOpen,
  onManageTags,
  inSheet = false,
  bottomInset = 24,
}: {
  /** Gate the first page load (e.g. the sheet's `visible`). */
  enabled: boolean;
  onOpen: (c: OpenConversation) => void;
  onManageTags: () => void;
  /** Inside a bottom sheet — use the sheet-aware text input for the search box. */
  inSheet?: boolean;
  /** Bottom padding for the list (safe-area on a full screen). */
  bottomInset?: number;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const [filterId, setFilterId] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const { items, loading, loadMore, removeItem, updateItem } = useSessions(enabled, 20, filterId, q);
  const [tagTarget, setTagTarget] = useState<Session | null>(null);

  const fallbackTitle = t('chat.newConversation');
  const SearchInput = inSheet ? BottomSheetTextInput : TextInput;

  function doDelete(s: Session) {
    Alert.alert(t('history.delete'), `确定删除「${s.title || fallbackTitle}」吗？`, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('history.delete'),
        style: 'destructive',
        onPress: () => {
          removeItem(s.id);
          deleteSession(s.id).catch(() => {});
        },
      },
    ]);
  }

  function rowActions(s: Session) {
    const buttons: AlertButton[] = [
      { text: t('history.delete'), style: 'destructive', onPress: () => doDelete(s) },
      { text: t('common.cancel'), style: 'cancel' },
    ];
    // Only owners can write tags — don't offer tagging on shared/non-owned sessions.
    if (s.is_owner !== false) {
      buttons.unshift({ text: t('tags.sessionTags'), onPress: () => setTagTarget(s) });
    }
    Alert.alert(s.title || fallbackTitle, undefined, buttons);
  }

  const searchBar = (
    <View style={styles.searchWrap}>
      <View style={styles.search}>
        <Icon name="search" size={17} color={c.fgMuted} />
        <SearchInput
          value={q}
          onChangeText={setQ}
          placeholder={t('history.searchPlaceholder')}
          placeholderTextColor={c.fgFaint}
          style={styles.searchInput}
        />
        {q ? (
          <Touchable haptic="none" onPress={() => setQ('')} hitSlop={8}>
            <Icon name="x" size={15} color={c.fgMuted} />
          </Touchable>
        ) : null}
      </View>
    </View>
  );

  return (
    <>
      <FlatList
        data={loading && items.length === 0 ? [] : items}
        keyExtractor={(s) => s.id}
        style={styles.list}
        contentContainerStyle={{ paddingBottom: bottomInset, flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View>
            {searchBar}
            <TagFilter activeId={filterId} onChange={setFilterId} />
          </View>
        }
        onEndReached={() => loadMore()}
        onEndReachedThreshold={0.5}
        ItemSeparatorComponent={RowSep}
        ListEmptyComponent={
          loading ? (
            <View style={{ paddingTop: 4 }}>
              {[0, 1, 2, 3, 4].map((i) => (
                <View key={i} style={styles.skelRow}>
                  <Skeleton style={{ height: 14, width: i % 2 ? '58%' : '72%' }} />
                </View>
              ))}
            </View>
          ) : (
            <EmptyState
              icon="msg"
              title={q ? t('history.emptySearch') : t('history.empty')}
              sub={q ? '换个关键词试试' : '从首页输入一句话即可开启新会话'}
            />
          )
        }
        ListFooterComponent={
          loading && items.length > 0 ? (
            <View style={styles.footLoad}>
              <Spinner size={14} />
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <HistoryRow
            session={item}
            onPress={() => onOpen({ id: item.id, title: item.title || fallbackTitle, readOnly: item.is_owner === false })}
            onLongPress={() => rowActions(item)}
          />
        )}
      />

      <TagSelectorSheet
        visible={!!tagTarget}
        onClose={() => setTagTarget(null)}
        sessionId={tagTarget?.id ?? ''}
        sessionTags={tagTarget?.tags ?? []}
        onChange={(newTags) => {
          if (!tagTarget) return;
          updateItem(tagTarget.id, { tags: newTags });
          setTagTarget((prev) => (prev ? { ...prev, tags: newTags } : prev));
        }}
        onManage={() => {
          setTagTarget(null);
          onManageTags();
        }}
      />
    </>
  );
}

/** Faint inset divider between history rows. */
function RowSep() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return <View style={styles.sep} />;
}

const useStyles = makeStyles((c) => ({
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: c.hairline, marginHorizontal: 16 },
  searchWrap: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: c.surfaceMuted,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    height: 40,
  },
  searchInput: { flex: 1, fontSize: font.body, color: c.fg, padding: 0 },
  list: { flex: 1 },
  skelRow: { paddingHorizontal: 16, paddingVertical: 13 },
  footLoad: { paddingVertical: 16, alignItems: 'center' },
}));
