/**
 * Full-screen table viewer — a modal page opened from an inline table's
 * pinned expand glyph. Native header (the table's title — a ```datatable's
 * own, else 表格 — and ✕ close); the grid scrolls on both axes (the page
 * vertically, the grid horizontally) at body size, and a narrow grid stretches
 * to the page width like it does inline. The grid arrives in memory through
 * the handoff store (`?k=`, kind `table`), never through navigation params.
 *
 * The card stretches rather than shrink-wrapping the grid: a fit-content card
 * (`alignSelf: 'flex-start'`) measured the horizontal scroller taller than its
 * rows and left a blank strip under the last one.
 */

import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { TableGrid, type TableData } from '../src/chat/markdown';
import { getHandoff } from '../src/lib/handoff';
import { useT } from '../src/lib/i18n';
import { makeStyles, radius, space, squircle, useTheme } from '../src/theme';
import { EmptyState } from '../src/ui/empty';
import { SheetClose } from '../src/ui/sheet-chrome';

export default function FullTable() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const { k, title } = useLocalSearchParams<{ k?: string; title?: string }>();
  const data = getHandoff<TableData>(k);
  const [avail, setAvail] = useState(0);

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: title ? String(title) : t('chat.table') }} />
      <SheetClose />
      {data ? (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
          <View style={styles.card} onLayout={(e) => setAvail(Math.floor(e.nativeEvent.layout.width))}>
            <TableGrid data={data} big avail={avail || undefined} />
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
  card: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.separator,
    overflow: 'hidden',
    ...squircle,
  },
  empty: { flex: 1, justifyContent: 'center' },
}));
