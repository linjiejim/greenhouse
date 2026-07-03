/**
 * Shared conversation-history pieces:
 *  - `useSessions`  — paginated session loader (infinite scroll; dedupes pages).
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
import { makeStyles, radius, useTheme } from '../theme';
import { Icon, Spinner, Touchable } from '../ui';

/* ----------------------------- pagination hook ----------------------------- */

export function useSessions(enabled: boolean, pageSize = 20) {
  const [items, setItems] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const offset = useRef(0);
  const busy = useRef(false);

  const loadMore = useCallback(async () => {
    if (busy.current || done) return;
    busy.current = true;
    setLoading(true);
    const batch = await listSessions({ limit: pageSize, offset: offset.current });
    setItems((prev) => {
      const seen = new Set(prev.map((p) => p.id));
      return [...prev, ...batch.filter((b) => !seen.has(b.id))];
    });
    offset.current += batch.length;
    if (batch.length < pageSize) setDone(true);
    busy.current = false;
    setLoading(false);
  }, [pageSize, done]);

  // Kick off the first page once the surface becomes visible.
  useEffect(() => {
    if (enabled && items.length === 0 && !done && !busy.current) void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const removeItem = useCallback((id: string) => setItems((it) => it.filter((x) => x.id !== id)), []);

  return { items, loading, done, loadMore, removeItem };
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
          {tags.map((t) => (
            <View key={t.id} style={styles.tagChip}>
              {t.color ? <View style={[styles.tagDot, { backgroundColor: t.color }]} /> : null}
              <Text numberOfLines={1} style={styles.tagText}>
                {t.name}
              </Text>
            </View>
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
  title: { flex: 1, fontSize: 14, fontWeight: '500', color: c.fg },
  time: { fontSize: 11.5, color: c.fgFaint, flexShrink: 0 },
  tags: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 5 },
  tagChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: c.surfaceMuted,
    borderRadius: radius.full,
    paddingVertical: 2,
    paddingHorizontal: 7,
    maxWidth: 130,
  },
  tagDot: { width: 6, height: 6, borderRadius: 3 },
  tagText: { fontSize: 11, fontWeight: '600', color: c.fgMuted },

  secHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
  secTitle: { flex: 1, fontSize: 12.5, fontWeight: '700', color: c.fgMuted, letterSpacing: 0.3 },
  more: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  moreText: { fontSize: 12.5, color: c.accent, fontWeight: '600' },

  center: { paddingTop: 24, alignItems: 'center' },
  empty: { paddingHorizontal: 16, paddingTop: 18, fontSize: 13, color: c.fgFaint },
  footLoad: { paddingVertical: 16, alignItems: 'center' },
}));
