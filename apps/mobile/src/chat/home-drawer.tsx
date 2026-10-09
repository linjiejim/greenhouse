/**
 * HomeDrawerContent — the left drawer behind the conversation surface
 * (ChatGPT / Claude-style sidebar, built from native pieces):
 *
 *  - top: a search field (filters the loaded history by title — see
 *    use-sessions; there is no server-side title search) + a new-chat button,
 *  - the member's own conversations (`scope=mine` — never anyone else's: a
 *    super used to get every member's history mixed in, read-only rows without
 *    a menu). Only the live part shows by default — 置顶 and 今天; everything
 *    older folds into one 「更早的对话」 row that expands in place (昨天 / 7 天内
 *    / 30 天内 / 更早, sticky section headers, infinite scroll). A search or a
 *    tag filter shows everything. Conversations others shared with the member
 *    sit in a folded 「共享给我」 group at the end. The active conversation is
 *    highlighted; long-press any row for its native context menu — 置顶 / 取消置顶
 *    for every row, plus 标签 / 重命名 / 删除 on the member's own; a tag filter
 *    lives in a native menu on the header,
 *  - pinned to the bottom: one row of app entries, icon over a caption
 *    (知识库 / 项目 / 设置; more than four collapse into 「更多」).
 *
 * History states: LoadingState while the first page loads, then EmptyState
 * (ContentUnavailableView) for 暂无对话 / 无匹配结果 / 加载失败 (with 重试).
 * A failed action is a system alert; a successful delete a short HUD.
 *
 * Rows are pinned to the panel width up front (`NativeMenu width`), so the
 * long-press menu doesn't measure-then-remount every row.
 *
 * Opening a conversation *replaces* the conversation surface (the drawer is
 * the navigation — no back stack; the (main) stack cross-fades) and slides the
 * drawer shut. The history refreshes in place every time the drawer opens, so
 * conversations started / renamed / deleted on the surface show up. What is on
 * screen comes from the home screen (src/bots/home/surface.ts), not the route.
 *
 * With Bots on (iOS, an internal account, `features.bots`), the Bots section
 * (src/bots/drawer/bots-section.tsx) comes first, above the history, and the
 * search filters it too; otherwise it renders nothing. Every route to home goes
 * through src/bots/nav.ts (all seven params — a Bots thread is `?c=`).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, SectionList, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useDrawerStatus, type DrawerContentComponentProps } from 'expo-router/drawer';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHomeSurface } from '../bots/home/surface';
import { useTags } from '../store/tags';
import { deleteSession, setSessionPinned, updateSessionTitle } from '../api/sessions';
import { BotsSection } from '../bots/drawer/bots-section';
import { openChat, openNewChat } from '../bots/nav';
import type { Session } from '../shared/greenhouse-types';
import { parseMs } from '../lib/format';
import { useT, type TranslationKey } from '../lib/i18n';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { Icon, type IconName, Touchable } from '../ui/core';
import { useFontScaleKey } from '../ui/font-scale';
import { alertError, confirmAction, promptText } from '../ui/dialogs';
import { DRAWER_W } from '../ui/drawer';
import { EmptyState, LoadingState } from '../ui/empty';
import { NativeMenu, menuSections, type MenuItem } from '../ui/menu';
import { toast } from '../ui/toast';
import { useSessions } from './use-sessions';

/** History rows sit inset in the panel; their menus get this width up front. */
const ROW_INSET = space.sm;
const ROW_W = DRAWER_W - ROW_INSET * 2;
/** The bottom bar shows this many entries; past it the last slot is 「更多」. */
const BAR_SLOTS = 4;

type Bucket = 'pinned' | 'today' | 'yesterday' | 'week' | 'month' | 'older';
const BUCKET_LABEL: Record<Bucket, TranslationKey> = {
  pinned: 'drawer.pinned',
  today: 'drawer.today',
  yesterday: 'drawer.yesterday',
  week: 'drawer.week',
  month: 'drawer.month',
  older: 'drawer.older',
};
/** Always shown; the rest fold into 「更早的对话」. */
const LIVE: readonly Bucket[] = ['pinned', 'today'];
const EARLIER: readonly Bucket[] = ['yesterday', 'week', 'month', 'older'];

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

/** A list row: a conversation, or the row that folds / unfolds a group. */
type Row =
  | { kind: 'session'; session: Session; shared: boolean }
  | { kind: 'fold'; fold: 'earlier' | 'shared'; open: boolean; count: number; more: boolean };

interface Section {
  key: string;
  /** '' = no header (a fold row's own section). */
  title: string;
  data: Row[];
}

/** The apps reachable from the drawer's bottom bar (no registry: three entries today). */
type AppPath = '/knowledge' | '/projects' | '/settings';
const APPS: ReadonlyArray<{ path: AppPath; icon: IconName; label: TranslationKey }> = [
  { path: '/knowledge', icon: 'books', label: 'drawer.knowledge' },
  { path: '/projects', icon: 'folder', label: 'drawer.projects' },
  { path: '/settings', icon: 'gear', label: 'drawer.settings' },
];

export function HomeDrawerContent({ navigation }: DrawerContentComponentProps) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Text containers are keyed on the text size so they re-measure when Dynamic Type changes (src/ui/font-scale.ts).
  const fontKey = useFontScaleKey();
  // What the home screen shows — not the route's params, which lag a restored thread (src/bots/home/surface.ts).
  // `c` = a Bots thread is on screen (no history row is current then); `profile` = a new chat with one
  // Bot — not the plain new chat either.
  const activeId = useHomeSurface((s) => s.id);
  const activeThread = useHomeSurface((s) => s.c);
  const activeProfile = useHomeSurface((s) => s.profile);

  const tags = useTags((s) => s.tags);
  const loadTags = useTags((s) => s.load);
  const filterId = useTags((s) => s.filterId);
  const setFilter = useTags((s) => s.setFilter);
  const [search, setSearch] = useState('');
  const query = search.trim();
  const mine = useSessions(true, 30, filterId, query);
  const shared = useSessions(true, 30, null, query, 'shared');
  const [earlierOpen, setEarlierOpen] = useState(false);
  const [sharedOpen, setSharedOpen] = useState(false);
  // A search or a tag filter is looking for something: show every group.
  const showAll = !!query || filterId != null;

  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  // Pick up conversations created / renamed / deleted / shared since the last look.
  const status = useDrawerStatus();
  const { refresh: refreshMine } = mine;
  const { refresh: refreshShared } = shared;
  useEffect(() => {
    if (status !== 'open') return;
    void refreshMine();
    void refreshShared();
  }, [status, refreshMine, refreshShared]);

  const sections = useMemo<Section[]>(() => {
    const now = new Date();
    const byBucket = new Map<Bucket, Row[]>();
    for (const session of mine.items) {
      const bucket = bucketOf(session, now);
      const row: Row = { kind: 'session', session, shared: false };
      const list = byBucket.get(bucket);
      if (list) list.push(row);
      else byBucket.set(bucket, [row]);
    }
    const group = (b: Bucket): Section => ({ key: b, title: t(BUCKET_LABEL[b]), data: byBucket.get(b)! });
    const out: Section[] = LIVE.filter((b) => byBucket.has(b)).map(group);
    const earlier = EARLIER.filter((b) => byBucket.has(b));
    const earlierCount = earlier.reduce((n, b) => n + byBucket.get(b)!.length, 0);
    if (showAll) out.push(...earlier.map(group));
    else if (earlierCount > 0) {
      out.push({
        key: 'fold:earlier',
        title: '',
        data: [{ kind: 'fold', fold: 'earlier', open: earlierOpen, count: earlierCount, more: !mine.done }],
      });
      if (earlierOpen) out.push(...earlier.map(group));
    }
    // Shared with the member: the rows already in "mine" (pinned ones) are not repeated.
    const own = new Set(mine.items.map((s) => s.id));
    const sharedRows = shared.items.filter((s) => !own.has(s.id));
    if (sharedRows.length) {
      const open = sharedOpen || !!query;
      out.push({
        key: 'fold:shared',
        title: '',
        data: [{ kind: 'fold', fold: 'shared', open, count: sharedRows.length, more: !shared.done }],
      });
      if (open)
        out.push({
          key: 'shared',
          title: '',
          data: sharedRows.map((session) => ({ kind: 'session' as const, session, shared: true })),
        });
    }
    return out;
  }, [mine.items, mine.done, shared.items, shared.done, showAll, earlierOpen, sharedOpen, query, t]);

  const close = useCallback(() => navigation.closeDrawer(), [navigation]);

  const openConversation = useCallback(
    (s: Session) => {
      close();
      if (s.id === activeId) return;
      openChat(router, { id: s.id, title: s.title ?? '', ro: s.is_owner === false });
    },
    [close, router, activeId],
  );

  // Already on a plain new chat → just close; anything else (a chat, a thread — a restored one
  // too —, a one-Bot new chat) → a plain one (`openNewChat` clears every home param).
  const newChat = useCallback(() => {
    close();
    if (activeId || activeThread || activeProfile) openNewChat(router);
  }, [close, router, activeId, activeThread, activeProfile]);

  // Close first, then push — the panel settles under the incoming page.
  const go = useCallback(
    (path: AppPath) => {
      close();
      setTimeout(() => router.push(path), 160);
    },
    [close, router],
  );

  const { patchItem: patchMine, removeItem: removeMine } = mine;
  const { patchItem: patchShared } = shared;
  const onRowMenu = useCallback(
    (s: Session, id: string) => {
      if (id === 'pin' || id === 'unpin') {
        const pinned = id === 'pin';
        void (async () => {
          patchMine(s.id, { pinned });
          patchShared(s.id, { pinned });
          if (!(await setSessionPinned(s.id, pinned))) {
            patchMine(s.id, { pinned: !pinned });
            patchShared(s.id, { pinned: !pinned });
            alertError(t(pinned ? 'drawer.pinFailed' : 'drawer.unpinFailed'));
            return;
          }
          // A shared row pinned by the member now belongs to "mine" (the server lists it with them).
          void refreshMine();
        })();
      } else if (id === 'tags') {
        close();
        setTimeout(() => router.push({ pathname: '/sheets/session-tags', params: { sessionId: s.id } }), 160);
      } else if (id === 'rename') {
        void (async () => {
          const current = s.title ?? '';
          const next = await promptText({
            title: t('chat.renameTitle'),
            defaultValue: current,
            confirmLabel: t('common.save'),
          });
          if (!next || next === current) return;
          patchMine(s.id, { title: next });
          if (!(await updateSessionTitle(s.id, next))) {
            patchMine(s.id, { title: current });
            alertError(t('chat.renameFailed'));
          }
        })();
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
          removeMine(s.id);
          toast(t('chat.deleted'), 'trash');
          if (s.id === activeId) openNewChat(router);
        })();
      }
    },
    [close, router, t, patchMine, patchShared, removeMine, refreshMine, activeId],
  );

  // Every row can be pinned (any conversation the member can see); tags, rename and delete are the owner's.
  const menus = useMemo(() => {
    const pin: MenuItem = { id: 'pin', title: t('drawer.pin'), icon: 'pin' };
    const unpin: MenuItem = { id: 'unpin', title: t('drawer.unpin'), icon: 'pinOff' };
    const owner: MenuItem[] = [
      { id: 'tags', title: t('chat.actionTags'), icon: 'tag' },
      { id: 'rename', title: t('chat.actionRename'), icon: 'pen' },
    ];
    const remove: MenuItem[] = [{ id: 'delete', title: t('common.delete'), icon: 'trash', destructive: true }];
    return {
      own: menuSections([[pin], owner, remove]),
      ownPinned: menuSections([[unpin], owner, remove]),
      other: menuSections([[pin]]),
      otherPinned: menuSections([[unpin]]),
    };
  }, [t]);

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
  const loadMoreRows = () => {
    if ((showAll || earlierOpen) && !mine.done) void mine.loadMore();
    if ((sharedOpen || !!query) && !shared.done) void shared.loadMore();
  };

  const renderRow = ({ item }: { item: Row }) => {
    if (item.kind === 'fold') {
      const label = item.fold === 'earlier' ? t('drawer.earlier') : t('drawer.sharedWithMe');
      const count = `${item.count}${item.more ? '+' : ''}`;
      return (
        <Pressable
          key={fontKey}
          onPress={() => (item.fold === 'earlier' ? setEarlierOpen((o) => !o) : setSharedOpen((o) => !o))}
          accessibilityRole="button"
          accessibilityLabel={`${label}, ${count}`}
          accessibilityState={{ expanded: item.open }}
          style={({ pressed }) => [styles.rowSlot, styles.fold, pressed && { backgroundColor: c.fill }]}
        >
          <Text numberOfLines={1} style={styles.foldText}>
            {label}
          </Text>
          <Text style={styles.foldCount}>{count}</Text>
          <Icon name={item.open ? 'chevD' : 'chevR'} size={12} weight="semibold" color={c.tertiaryLabel} />
        </Pressable>
      );
    }
    const s = item.session;
    const owner = s.is_owner !== false && !item.shared;
    const row = (
      <Pressable
        key={fontKey}
        onPress={() => openConversation(s)}
        accessibilityRole="button"
        accessibilityLabel={s.title || t('chat.newConversation')}
        accessibilityState={{ selected: s.id === activeId }}
        style={({ pressed }) => [
          styles.row,
          s.id === activeId && { backgroundColor: c.tertiaryFill },
          pressed && { backgroundColor: c.fill },
        ]}
      >
        <Text numberOfLines={1} style={[styles.rowText, s.id === activeId && styles.rowTextActive]}>
          {s.title || t('chat.newConversation')}
        </Text>
        {!owner ? <Icon name="users" size={13} color={c.tertiaryLabel} /> : null}
      </Pressable>
    );
    const items = owner
      ? s.pinned
        ? menus.ownPinned
        : menus.own
      : s.pinned
        ? menus.otherPinned
        : menus.other;
    return (
      <NativeMenu
        trigger="longPress"
        items={items}
        onSelect={(id) => onRowMenu(s, id)}
        width={ROW_W}
        style={styles.rowSlot}
      >
        {row}
      </NativeMenu>
    );
  };

  const apps = APPS.length > BAR_SLOTS ? APPS.slice(0, BAR_SLOTS - 1) : APPS;
  const overflow = APPS.length > BAR_SLOTS ? APPS.slice(BAR_SLOTS - 1) : [];
  const overflowItems = useMemo<MenuItem[]>(
    () => overflow.map((app) => ({ id: app.path, title: t(app.label), icon: app.icon })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- APPS is a module constant
    [t],
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top + space.sm }]}>
      {/* search + new chat */}
      <View style={styles.topRow}>
        <View style={styles.search}>
          <Icon name="search" size={16} color={c.secondaryLabel} />
          <TextInput
            key={fontKey}
            // a fixed-height field, like the system search bar: its text stops growing at 1.3×
            maxFontSizeMultiplier={1.3}
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

      <SectionList<Row, Section>
        sections={sections}
        keyExtractor={(row) => (row.kind === 'session' ? `${row.shared ? 's' : 'm'}:${row.session.id}` : row.fold)}
        stickySectionHeadersEnabled
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onEndReached={loadMoreRows}
        onEndReachedThreshold={0.4}
        extraData={fontKey}
        ListHeaderComponent={
          <>
            <BotsSection query={search} onClose={close} />
            <View key={fontKey} style={styles.navBlock}>
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
        renderSectionHeader={({ section }) =>
          section.title ? (
            <View key={fontKey} style={styles.sectionHead}>
              <Text style={styles.sectionText}>{section.title}</Text>
            </View>
          ) : null
        }
        renderItem={renderRow}
        ListEmptyComponent={
          mine.loading ? (
            <LoadingState style={styles.emptyLoading} />
          ) : mine.error ? (
            <EmptyState icon="alert" title={t('drawer.loadFailed')} onRetry={() => void refreshMine()} />
          ) : query ? (
            <EmptyState icon="search" title={t('drawer.noResults')} message={t('drawer.noResultsHint')} />
          ) : (
            <EmptyState icon="msgs" title={t('drawer.empty')} />
          )
        }
        ListFooterComponent={<View style={{ height: space.lg }} />}
        style={{ flex: 1 }}
      />

      {/* pinned to the bottom: one row of apps, icon over a caption */}
      <View key={fontKey} style={[styles.bar, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
        {apps.map((app) => (
          <BarItem key={app.path} icon={app.icon} label={t(app.label)} onPress={() => go(app.path)} />
        ))}
        {overflow.length ? (
          <NativeMenu items={overflowItems} onSelect={(id) => go(id as AppPath)} style={styles.barSlot}>
            <BarItem icon="more" label={t('drawer.more')} />
          </NativeMenu>
        ) : null}
      </View>
    </View>
  );
}

/** One entry of the bottom bar: an icon over a small caption, a full-height touch target. */
function BarItem({ icon, label, onPress }: { icon: IconName; label: string; onPress?: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const content = (
    <>
      <Icon name={icon} size={22} color={c.label} />
      <Text numberOfLines={1} style={styles.barLabel}>
        {label}
      </Text>
    </>
  );
  // without onPress it is a menu's trigger: the menu owns the touch
  return onPress ? (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.barSlot, styles.barItem, pressed && { opacity: 0.5 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {content}
    </Pressable>
  ) : (
    <View style={styles.barItem} accessible accessibilityRole="button" accessibilityLabel={label}>
      {content}
    </View>
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
  navBlock: { paddingHorizontal: space.sm },
  historyHead: { flexDirection: 'row', alignItems: 'center', marginTop: space.xs, paddingLeft: space.sm + 2 },
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
  fold: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    minHeight: 40,
    marginTop: space.sm,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.md,
    ...squircle,
  },
  foldText: { flex: 1, ...typo.subheadline, fontWeight: weight.medium, color: c.secondaryLabel },
  foldCount: { ...typo.footnote, color: c.tertiaryLabel, fontVariant: ['tabular-nums'] },
  emptyLoading: { flexGrow: 0, paddingTop: space.xxl },
  bar: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingTop: space.xs,
    paddingHorizontal: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.separator,
  },
  barSlot: { flex: 1 },
  barItem: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    minHeight: HIT + 6,
    paddingVertical: space.xs,
    borderRadius: radius.md,
    ...squircle,
  },
  barLabel: { ...typo.caption2, color: c.secondaryLabel },
}));
