/**
 * Fullscreen table viewer — opened from the inline table's “全屏” button. Lets a
 * wide grid be read with both-axis scrolling (vertical page scroll + the grid's
 * own horizontal scroll) at a larger type size. The grid is handed over in-memory
 * via table-store (keyed by `k`) rather than serialised through nav params.
 */

import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getTable } from '../src/chat/table-store';
import { TableGrid } from '../src/chat/markdown';
import { ScreenHeader } from '../src/ui';
import { font, makeStyles, useTheme } from '../src/theme';

export default function FullTable() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const { k, title } = useLocalSearchParams<{ k?: string; title?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const data = getTable(k);

  return (
    <View style={[styles.root, { paddingTop: insets.top + 4 }]}>
      <ScreenHeader
        variant="compact"
        leading="close"
        title={title ? String(title) : '表格'}
        subtitle={data ? `${data.head.length} 列 · ${data.rows.length} 行 · 横屏阅读更佳` : undefined}
        onLeading={() => router.back()}
        bordered
      />

      {data ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: insets.bottom + 24 }}>
          <TableGrid data={data} big />
        </ScrollView>
      ) : (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>表格已失效，请返回后重新打开。</Text>
        </View>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hairline,
  },
  btn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: font.title, fontWeight: '700', color: c.fg },
  sub: { fontSize: font.caption, color: c.fgMuted, marginTop: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyText: { fontSize: font.label, color: c.fgMuted },
}));
