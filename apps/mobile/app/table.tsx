/**
 * Full-screen table viewer — a modal page opened from an inline table's “全屏”
 * capsule. Native header (title, ✕ close) over a column/row count; the grid
 * scrolls on both axes (the page vertically, the grid horizontally) at body
 * size. The grid arrives in memory through the handoff
 * store (`?k=`, kind `table`), never through navigation params.
 */

import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { TableGrid, type TableData } from '../src/chat/markdown';
import { getHandoff } from '../src/lib/handoff';
import { useT } from '../src/lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme } from '../src/theme';
import { EmptyState } from '../src/ui/empty';
import { SheetClose } from '../src/ui/sheet-chrome';

export default function FullTable() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const { k, title } = useLocalSearchParams<{ k?: string; title?: string }>();
  const data = getHandoff<TableData>(k);

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: title ? String(title) : t('chat.table') }} />
      <SheetClose />
      {data ? (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
          <Text style={styles.meta}>{t('chat.tableMeta', { cols: data.head.length, rows: data.rows.length })}</Text>
          <View style={styles.card}>
            <TableGrid data={data} big />
          </View>
        </ScrollView>
      ) : (
        <View style={styles.empty}>
          <EmptyState icon="table" title={t('chat.expired')} message={t('chat.expiredHint')} />
        </View>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.background },
  content: { padding: space.margin, paddingBottom: space.xxxl },
  meta: { ...typo.footnote, color: c.secondaryLabel, marginBottom: space.sm },
  card: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.separator,
    overflow: 'hidden',
    ...squircle,
  },
  empty: { flex: 1, justifyContent: 'center' },
}));
