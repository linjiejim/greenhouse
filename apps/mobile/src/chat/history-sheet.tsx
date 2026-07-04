/**
 * History sheet — the full conversation list, opened from the drawer's
 * "查看更多". Search by title (server-side ?q= filtering, so matches on unloaded
 * pages stay reachable) and a tag filter bar (server-side ?tag_id filtering);
 * compact rows (title + relative time, tag chips below) shared with the drawer
 * via <HistoryRow>. Long-press a row for actions (tag / delete). The header's
 * tag button opens the tag manager. Infinite-scroll pagination.
 */

import React, { useState } from 'react';
import { Alert, type AlertButton, FlatList, View } from 'react-native';
import { deleteSession } from '../api/sessions';
import type { Session } from '../shared/greenhouse-types';
import { useT } from '../lib/i18n';
import { font, makeStyles, radius, useTheme } from '../theme';
import { BottomSheetTextInput, EmptyState, Icon, Sheet, Skeleton, Spinner, Touchable } from '../ui';
import { HistoryRow, useSessions } from './history-list';
import { TagFilter } from './tag-filter';
import { TagManagerSheet } from './tag-manager-sheet';
import { TagSelectorSheet } from './tag-selector-sheet';

export interface OpenConversation {
  id: string;
  title: string;
  readOnly: boolean;
}

export function HistorySheet({
  visible,
  onClose,
  onOpen,
}: {
  visible: boolean;
  onClose: () => void;
  onOpen: (c: OpenConversation) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const [filterId, setFilterId] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const { items, loading, loadMore, removeItem, updateItem } = useSessions(visible, 20, filterId, q);
  const [managerOpen, setManagerOpen] = useState(false);
  const [tagTarget, setTagTarget] = useState<Session | null>(null);

  const fallbackTitle = t('chat.newConversation');

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
        <BottomSheetTextInput
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
      <Sheet
        visible={visible}
        onClose={onClose}
        title={t('history.title')}
        heightPct={88}
        nativeScroll
        headerRight={
          <Touchable haptic="none" onPress={() => setManagerOpen(true)} style={styles.manageBtn}>
            <Icon name="tags" size={18} color={c.fgMuted} />
          </Touchable>
        }
      >
        <FlatList
          data={loading && items.length === 0 ? [] : items}
          keyExtractor={(c) => c.id}
          style={styles.list}
          contentContainerStyle={{ paddingBottom: 24, flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <View>
              {searchBar}
              <TagFilter activeId={filterId} onChange={setFilterId} />
            </View>
          }
          onEndReached={() => loadMore()}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={
            loading ? (
              <View style={{ paddingTop: 4 }}>
                {[0, 1, 2, 3, 4].map((i) => (
                  <View key={i} style={styles.skelRow}>
                    <Skeleton style={{ height: 13, width: '70%', marginBottom: 7 }} />
                    <Skeleton style={{ height: 11, width: '30%' }} />
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
      </Sheet>

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
          setManagerOpen(true);
        }}
      />
      <TagManagerSheet visible={managerOpen} onClose={() => setManagerOpen(false)} />
    </>
  );
}

const useStyles = makeStyles((c) => ({
  manageBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
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
  skelRow: { paddingHorizontal: 16, paddingVertical: 11 },
  footLoad: { paddingVertical: 16, alignItems: 'center' },
}));
