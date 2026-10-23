/**
 * Shared conversation-history pieces:
 *  - `useSessions`  — paginated session loader (infinite scroll; dedupes pages;
 *                     debounced title search, which hard-resets pagination on change).
 *  - `HistoryRow`   — compact single-line row: title (left) and the relative time
 *                     on the right; no leading avatar/icon. Used by the shared <HistoryBrowser>
 *                     (top-bar popup + standalone /history page).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { listSessions } from '../api/sessions';
import type { Session } from '../shared/greenhouse-types';
import { shortTime } from '../lib/format';
import { useT } from '../lib/i18n';
import { font, makeStyles, useTheme } from '../theme';
import { Icon, Touchable } from '../ui';

/* ----------------------------- pagination hook ----------------------------- */

export function useSessions(enabled: boolean, pageSize = 20, search = '') {
  const [items, setItems] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const offset = useRef(0);
  const busy = useRef(false);
  const doneRef = useRef(false);
  const searchRef = useRef(search);

  const loadMore = useCallback(async () => {
    if (busy.current || doneRef.current) return;
    busy.current = true;
    setLoading(true);
    const forSearch = searchRef.current;
    const batch = await listSessions({ limit: pageSize, offset: offset.current, search: forSearch || undefined });
    // The search term changed while this page was in flight — discard it.
    if (searchRef.current !== forSearch) {
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

  // Search change → hard reset + reload (skips the initial mount).
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    searchRef.current = debouncedSearch;
    offset.current = 0;
    doneRef.current = false;
    busy.current = false;
    setDone(false);
    setItems([]);
    if (enabled) void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

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
    </Touchable>
  );
}

const useStyles = makeStyles((c) => ({
  row: { paddingHorizontal: 16, paddingVertical: 12 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontSize: font.label, fontWeight: '500', color: c.fg },
  time: { fontSize: font.caption, color: c.fgFaint, flexShrink: 0 },
}));
