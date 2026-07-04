/**
 * Shared conversation-history pieces:
 *  - `useSessions`  — paginated session loader (infinite scroll; dedupes pages;
 *                     optional server-side tag filter + debounced title search,
 *                     both hard-reset pagination on change).
 *  - `HistoryRow`   — compact row: title (left) + relative time (right), tags on a
 *                     second line, no leading avatar/icon. Used by the drawer
 *                     section and the full-screen history sheet.
 *  - `DrawerHistory`— the drawer's embedded "历史会话" section: a section header
 *                     with a "查看更多" link over an infinite-scroll list.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { listSessions } from '../api/sessions';
import type { Session } from '../shared/greenhouse-types';
import { shortTime } from '../lib/format';
import { useT } from '../lib/i18n';
import { font, makeStyles, useTheme } from '../theme';
import { Icon, Spinner, Touchable } from '../ui';
import { TagChip } from './tag-chip';

/* ----------------------------- pagination hook ----------------------------- */

export function useSessions(enabled: boolean, pageSize = 20, tagId: number | null = null, search = '') {
  const [items, setItems] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const offset = useRef(0);
  const busy = useRef(false);
  const doneRef = useRef(false);
  const tagRef = useRef<number | null>(tagId);
  const searchRef = useRef(search);

  const loadMore = useCallback(async () => {
    if (busy.current || doneRef.current) return;
    busy.current = true;
    setLoading(true);
    const forTag = tagRef.current;
    const forSearch = searchRef.current;
    const batch = await listSessions({ limit: pageSize, offset: offset.current, tagId: forTag, search: forSearch || undefined });
    // The tag filter or search term changed while this page was in flight — discard it.
    if (tagRef.current !== forTag || searchRef.current !== forSearch) {
      busy.current = false;
      setLoading(false);
      return;
    }
    setItems((prev) => {
      const seen = new Set(prev.map((p) => p.id));
      return [...prev, ...batch.filter((b) => !seen.has(b.id))];
    });
    offset.current += batch.length;
    if (batch.length < pageSize) {
      doneRef.current = true;
      setDone(true);
    }
    busy.current = false;
    setLoading(false);
  }, [pageSize]);

  // Kick off the first page once the surface becomes visible.
  useEffect(() => {
    if (enabled && items.length === 0 && !doneRef.current && !busy.current) void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Debounce the search term so typing doesn't fire a request per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(id);
  }, [search]);

  // Tag filter or search change → hard reset + reload (skips the initial mount).
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    tagRef.current = tagId;
    searchRef.current = debouncedSearch;
    offset.current = 0;
    doneRef.current = false;
    busy.current = false;
    setDone(false);
    setItems([]);
    if (enabled) void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagId, debouncedSearch]);

  const removeItem = useCallback((id: string) => setItems((it) => it.filter((x) => x.id !== id)), []);
  const updateItem = useCallback(
    (id: string, patch: Partial<Session>) => setItems((it) => it.map((x) => (x.id === id ? { ...x, ...patch } : x))),
    [],
  );

  return { items, loading, done, loadMore, removeItem, updateItem };
}

/* ----------------------------- compact row ----------------------------- */

export function HistoryRow({
  session,
  onPress,
  onLongPress,
}: {
  session: Session;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const tags = session.tags?.slice(0, 3) ?? [];
  return (
    <Touchable
      haptic="none"
      onPress={onPress}
      onLongPress={onLongPress}
      pressedStyle={{ backgroundColor: c.surfaceMuted }}
      style={styles.row}
    >
      <View style={styles.top}>
        <Text numberOfLines={1} style={styles.title}>
          {session.title || t('chat.newConversation')}
        </Text>
        {session.share_count ? <Icon name="share" size={12} color={c.fgFaint} /> : null}
        <Text style={styles.time}>{shortTime(session.updated_at)}</Text>
      </View>
      {tags.length ? (
        <View style={styles.tags}>
          {tags.map((tag) => (
            <TagChip key={tag.id} tag={tag} />
          ))}
        </View>
      ) : null}
    </Touchable>
  );
}

/* ----------------------------- drawer section ----------------------------- */

export function DrawerHistory({ onOpen, onViewAll }: { onOpen: (s: Session) => void; onViewAll: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const { items, loading, loadMore } = useSessions(true);
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.secHead}>
        <Text style={styles.secTitle}>{t('history.title')}</Text>
        <Touchable haptic="none" onPress={onViewAll} style={styles.more} hitSlop={6}>
          <Text style={styles.moreText}>{t('history.viewMore')}</Text>
          <Icon name="chevR" size={14} color={c.fgFaint} />
        </Touchable>
      </View>
      <FlatList
        data={items}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => <HistoryRow session={item} onPress={() => onOpen(item)} />}
        onEndReached={() => loadMore()}
        onEndReachedThreshold={0.5}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          loading ? (
            <View style={styles.center}>
              <Spinner size={16} />
            </View>
          ) : (
            <Text style={styles.empty}>{t('history.empty')}</Text>
          )
        }
        ListFooterComponent={
          loading && items.length > 0 ? (
            <View style={styles.footLoad}>
              <Spinner size={14} />
            </View>
          ) : null
        }
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  row: { paddingHorizontal: 16, paddingVertical: 9 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontSize: font.label, fontWeight: '500', color: c.fg },
  time: { fontSize: font.caption, color: c.fgFaint, flexShrink: 0 },
  tags: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 5 },

  secHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
  secTitle: { flex: 1, fontSize: font.caption, fontWeight: '700', color: c.fgMuted, letterSpacing: 0.3 },
  more: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  moreText: { fontSize: font.caption, color: c.accent, fontWeight: '600' },

  center: { paddingTop: 24, alignItems: 'center' },
  empty: { paddingHorizontal: 16, paddingTop: 18, fontSize: font.small, color: c.fgFaint },
  footLoad: { paddingVertical: 16, alignItems: 'center' },
}));
