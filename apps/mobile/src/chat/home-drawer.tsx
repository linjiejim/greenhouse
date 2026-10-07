/**
 * HomeDrawerContent — the left drawer behind the conversation surface
 * (ChatGPT / Claude-style sidebar, built from native pieces):
 *
 *  - top: a search field (filters the loaded history by title — see
 *    use-sessions; there is no server-side title search) + a new-chat button,
 *  - navigation rows to 知识库 / 项目,
 *  - the conversation history, grouped by recency (置顶 / 今天 / 昨天 / 7 天内 /
 *    30 天内 / 更早) with sticky section headers and infinite scroll; the active
 *    conversation is highlighted; long-press a row for its native context menu
 *    (标签 / 删除); a tag filter lives in a native menu on the header,
 *  - footer: the account row (avatar · name · station) → Settings.
 *
 * History states: LoadingState while the first page loads, then EmptyState
 * (ContentUnavailableView) for 暂无对话 / 无匹配结果 / 加载失败 (with 重试).
 * A failed delete is a system alert; a successful one a short HUD.
 *
 * Rows are pinned to the panel width up front (`NativeMenu width`), so the
 * long-press menu doesn't measure-then-remount every row.
 *
 * Opening a conversation *replaces* the conversation surface (the drawer is
 * the navigation — no back stack; the (main) stack cross-fades) and slides the
 * drawer shut. The history refreshes in place every time the drawer opens, so
 * conversations started / renamed / deleted on the surface show up.
 *
 * With Bots on (iOS, an internal account, `features.bots`), the Bots section
 * (src/bots/drawer/bots-section.tsx) comes first, above 知识库 / 项目, and the
 * search filters it too; otherwise it renders nothing and the drawer is exactly
 * as before. Every route to home goes through src/bots/nav.ts (all seven
 * params — a Bots thread is the same route with `?c=`).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, SectionList, StyleSheet, Text, TextInput, View } from 'react-native';
import { useGlobalSearchParams, useRouter } from 'expo-router';
import { useDrawerStatus, type DrawerContentComponentProps } from 'expo-router/drawer';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../store/auth';
import { useTags } from '../store/tags';
import { useActiveStation } from '../stations/use-active-station';
import { deleteSession } from '../api/sessions';
import { BotsSection } from '../bots/drawer/bots-section';
import { openChat, openNewChat } from '../bots/nav';
import type { Session } from '../shared/greenhouse-types';
import { parseMs } from '../lib/format';
import { useT, type TranslationKey } from '../lib/i18n';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { Icon, type IconName, Touchable } from '../ui/core';
import { InitialAvatar } from '../ui/avatar';
import { alertError, confirmAction } from '../ui/dialogs';
import { DRAWER_W } from '../ui/drawer';
import { EmptyState, LoadingState } from '../ui/empty';
import { NativeMenu, menuSections, type MenuItem } from '../ui/menu';
import { toast } from '../ui/toast';
import { useSessions } from './use-sessions';

/** History rows sit inset in the panel; their menus get this width up front. */
const ROW_INSET = space.sm;
const ROW_W = DRAWER_W - ROW_INSET * 2;

type Bucket = 'pinned' | 'today' | 'yesterday' | 'week' | 'month' | 'older';
const BUCKET_LABEL: Record<Bucket, TranslationKey> = {
  pinned: 'drawer.pinned',
  today: 'drawer.today',
  yesterday: 'drawer.yesterday',
  week: 'drawer.week',
  month: 'drawer.month',
  older: 'drawer.older',
};

function bucketOf(s: Session, now: Date): Bucket {
  if (s.pinned) return 'pinned';
  const ms = parseMs(s.updated_at || s.created_at);
  if (!ms) return 'older';
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  if (ms >= startOfToday) return 'today';
  if (ms >= startOfToday - day) return 'yesterday';
  if (ms >= startOfToday - 6 * day) return 'week';
  if (ms >= startOfToday - 29 * day) return 'month';
  return 'older';
}

export function HomeDrawerContent({ navigation }: DrawerContentComponentProps) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const user = useAuth((s) => s.user);
  const station = useActiveStation();
  // `c` = a Bots thread is on screen (no history row is current then).
  const { id: activeId, c: activeThread } = useGlobalSearchParams<{ id?: string; c?: string }>();

  const tags = useTags((s) => s.tags);
  const loadTags = useTags((s) => s.load);
  const filterId = useTags((s) => s.filterId);
  const setFilter = useTags((s) => s.setFilter);
  const [search, setSearch] = useState('');
  const { items, loading, done, error, loadMore, refresh, removeItem } = useSessions(
    true,
    30,
    filterId,
    search.trim(),
  );

  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  // Pick up conversations created / renamed / deleted since the last look.
  const status = useDrawerStatus();
  useEffect(() => {
    if (status === 'open') void refresh();
  }, [status, refresh]);

  const sections = useMemo(() => {
    const now = new Date();
    const order: Bucket[] = ['pinned', 'today', 'yesterday', 'week', 'month', 'older'];
    const map = new Map<Bucket, Session[]>();
    for (const s of items) {
      const b = bucketOf(s, now);
      const arr = map.get(b);
      if (arr) arr.push(s);
      else map.set(b, [s]);
    }
    return order.filter((b) => map.has(b)).map((b) => ({ key: b, title: t(BUCKET_LABEL[b]), data: map.get(b)! }));
  }, [items, t]);

  const close = useCallback(() => navigation.closeDrawer(), [navigation]);

  const openConversation = useCallback(
    (s: Session) => {
      close();
      if (s.id === activeId) return;
      openChat(router, { id: s.id, title: s.title ?? '', ro: s.is_owner === false });
    },
    [close, router, activeId],
  );

  const newChat = useCallback(() => {
    close();
    if (activeId || activeThread) openNewChat(router);
  }, [close, router, activeId, activeThread]);

  // Close first, then push — the panel settles under the incoming page.
  const go = useCallback(
    (path: '/knowledge' | '/projects' | '/settings') => {
      close();
      setTimeout(() => router.push(path), 160);
    },
    [close, router],
  );

  const onRowMenu = useCallback(
    (s: Session, id: string) => {
      if (id === 'tags') {
        close();
        setTimeout(() => router.push({ pathname: '/sheets/session-tags', params: { sessionId: s.id } }), 160);
      } else if (id === 'delete') {
        void (async () => {
          const ok = await confirmAction({
            title: t('drawer.deleteTitle'),
            message: s.title || t('chat.newConversation'),
            confirmLabel: t('common.delete'),
            destructive: true,
          });
          if (!ok) return;
          if (!(await deleteSession(s.id))) {
            alertError(t('chat.deleteFailed'));
            return;
          }
          removeItem(s.id);
          toast(t('chat.deleted'), 'trash');
          if (s.id === activeId) openNewChat(router);
        })();
      }
    },
    [close, router, t, removeItem, activeId],
  );

  // Shared conversations (not the owner's) get no menu: tags and delete are owner-only.
  const rowItems = useMemo<MenuItem[]>(
    () =>
      menuSections([
        [{ id: 'tags', title: t('chat.actionTags'), icon: 'tag' }],
        [{ id: 'delete', title: t('common.delete'), icon: 'trash', destructive: true }],
      ]),
    [t],
  );

  const filterItems = useMemo<MenuItem[]>(
    () =>
      menuSections([
        [{ id: 'all', title: t('drawer.allConversations'), checked: filterId == null }],
        tags.map((tag) => ({
          id: String(tag.id),
          title: tag.name,
          icon: 'tag' as IconName,
          checked: filterId === tag.id,
        })),
      ]),
    [tags, filterId, t],
  );

  const activeTag = filterId != null ? tags.find((x) => x.id === filterId) : undefined;
  const nickname = user?.nickname ?? t('home.fallbackName');

  return (
    <View style={[styles.root, { paddingTop: insets.top + space.sm }]}>
      {/* search + new chat */}
      <View style={styles.topRow}>
        <View style={styles.search}>
          <Icon name="search" size={16} color={c.secondaryLabel} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder={t('drawer.search')}
            placeholderTextColor={c.placeholder}
            returnKeyType="search"
            clearButtonMode="while-editing"
            autoCorrect={false}
            style={styles.searchInput}
          />
        </View>
        <Touchable
          onPress={newChat}
          style={styles.topBtn}
          accessibilityRole="button"
          accessibilityLabel={t('drawer.newChat')}
        >
          <Icon name="compose" size={22} color={c.label} />
        </Touchable>
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(s) => s.id}
        stickySectionHeadersEnabled
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onEndReached={() => {
          if (!done) void loadMore();
        }}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <>
            <BotsSection query={search} onClose={close} />
            <View style={styles.navBlock}>
              <NavRow icon="books" label={t('drawer.knowledge')} onPress={() => go('/knowledge')} />
              <NavRow icon="folder" label={t('drawer.projects')} onPress={() => go('/projects')} />
              <View style={styles.historyHead}>
                <Text style={styles.historyTitle}>{activeTag ? activeTag.name : t('drawer.history')}</Text>
                {tags.length ? (
                  <NativeMenu
                    title={t('drawer.filterByTag')}
                    items={filterItems}
                    onSelect={(id) => setFilter(id === 'all' ? null : Number(id))}
                  >
                    <View
                      style={styles.filterBtn}
                      accessible
                      accessibilityRole="button"
                      accessibilityLabel={t('drawer.filterByTag')}
                    >
                      <Icon name="filter" size={17} color={activeTag ? c.accent : c.secondaryLabel} weight="medium" />
                    </View>
                  </NativeMenu>
                ) : null}
              </View>
            </View>
          </>
        }
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHead}>
            <Text style={styles.sectionText}>{section.title}</Text>
          </View>
        )}
        renderItem={({ item }) => {
          const row = (
            <Pressable
              onPress={() => openConversation(item)}
              accessibilityRole="button"
              accessibilityLabel={item.title || t('chat.newConversation')}
              accessibilityState={{ selected: item.id === activeId }}
              style={({ pressed }) => [
                styles.row,
                item.id === activeId && { backgroundColor: c.tertiaryFill },
                pressed && { backgroundColor: c.fill },
              ]}
            >
              <Text numberOfLines={1} style={[styles.rowText, item.id === activeId && styles.rowTextActive]}>
                {item.title || t('chat.newConversation')}
              </Text>
              {item.shared ? <Icon name="users" size={13} color={c.tertiaryLabel} /> : null}
            </Pressable>
          );
          return item.is_owner === false ? (
            <View style={styles.rowSlot}>{row}</View>
          ) : (
            <NativeMenu
              trigger="longPress"
              items={rowItems}
              onSelect={(id) => onRowMenu(item, id)}
              width={ROW_W}
              style={styles.rowSlot}
            >
              {row}
            </NativeMenu>
          );
        }}
        ListEmptyComponent={
          loading ? (
            <LoadingState style={styles.emptyLoading} />
          ) : error ? (
            <EmptyState icon="alert" title={t('drawer.loadFailed')} onRetry={() => void refresh()} />
          ) : search.trim() ? (
            <EmptyState icon="search" title={t('drawer.noResults')} message={t('drawer.noResultsHint')} />
          ) : (
            <EmptyState icon="msgs" title={t('drawer.empty')} />
          )
        }
        ListFooterComponent={<View style={{ height: space.lg }} />}
        style={{ flex: 1 }}
      />

      {/* account → settings */}
      <Pressable
        onPress={() => go('/settings')}
        style={({ pressed }) => [
          styles.account,
          { paddingBottom: insets.bottom + space.sm },
          pressed && { opacity: 0.6 },
        ]}
        accessibilityRole="button"
        accessibilityLabel={t('drawer.settings')}
      >
        <InitialAvatar name={nickname} size={34} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={styles.accountName}>
            {nickname}
          </Text>
          {station ? (
            <Text numberOfLines={1} style={styles.accountSub}>
              {station.name}
            </Text>
          ) : null}
        </View>
        <Icon name="gear" size={20} color={c.secondaryLabel} />
      </Pressable>
    </View>
  );
}

function NavRow({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.navRow, pressed && { backgroundColor: c.fill }]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon name={icon} size={20} color={c.label} />
      <Text style={styles.navText}>{label}</Text>
    </Pressable>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.background },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
  },
  search: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    height: 38,
    paddingHorizontal: space.md - 2,
    borderRadius: 19,
    backgroundColor: c.tertiaryFill,
    ...squircle,
  },
  searchInput: { flex: 1, ...typo.body, color: c.label, paddingVertical: 0 },
  topBtn: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  navBlock: { paddingHorizontal: space.sm, paddingTop: space.xs },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: HIT,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.md,
    ...squircle,
  },
  navText: { ...typo.body, color: c.label },
  historyHead: { flexDirection: 'row', alignItems: 'center', marginTop: space.md, paddingLeft: space.sm + 2 },
  historyTitle: { ...typo.footnote, fontWeight: weight.semibold, color: c.secondaryLabel, flex: 1 },
  filterBtn: { width: 36, height: 32, alignItems: 'center', justifyContent: 'center' },
  sectionHead: {
    backgroundColor: c.background,
    paddingHorizontal: space.lg + 2,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
  sectionText: { ...typo.footnote, color: c.tertiaryLabel, fontWeight: weight.medium },
  rowSlot: { marginHorizontal: ROW_INSET },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 40,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.md,
    ...squircle,
  },
  rowText: { flex: 1, ...typo.body, color: c.label },
  rowTextActive: { fontWeight: weight.semibold },
  emptyLoading: { flexGrow: 0, paddingTop: space.xxl },
  account: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.separator,
  },
  accountName: { ...typo.headline, color: c.label },
  accountSub: { ...typo.footnote, color: c.secondaryLabel },
}));
