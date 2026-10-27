import { ScreenActions } from '../src/ui/screen-actions';
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
import { TableGrid, type TableData } from '../src/markdown';
import { getHandoff } from '../src/lib/handoff';
import { useT } from '../src/lib/i18n';
import { makeStyles, radius, space, squircle, useTheme } from '../src/theme';
import { EmptyState } from '../src/ui/empty';
import { TableRecords } from '../src/markdown/blocks/table';
import { Segmented } from '../src/ui/segmented';
import { SheetClose } from '../src/ui/sheet-chrome';
import { SidewaysTable } from '../src/ui/sideways';

export default function FullTable() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const { k, title } = useLocalSearchParams<{ k?: string; title?: string }>();
  const data = getHandoff<TableData>(k, 'table');
  const [avail, setAvail] = useState(0);
  const [sideways, setSideways] = useState(false);
  const [mode, setMode] = useState<'records' | 'grid'>(data && data.head.length > 4 ? 'records' : 'grid');

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: title ? String(title) : t('chat.table') }} />
      <SheetClose />
      {data ? (
        <ScreenActions
          placement={'right'}
          actions={[
            {
              id: 'action-1',
              icon: 'sideways' as const,
              label: t('tables.sideways'),
              onPress: () => setSideways(true),
            },
          ]}
        />
      ) : null}
      {data ? (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
          <Segmented
            value={mode}
            options={[
              { value: 'records', label: t('chat.tableRecords') },
              { value: 'grid', label: t('chat.tableGrid') },
            ]}
            onChange={setMode}
            style={{ marginBottom: space.md }}
          />
          <View style={styles.card} onLayout={(e) => setAvail(Math.floor(e.nativeEvent.layout.width))}>
            {mode === 'records' ? (
              <TableRecords data={data} />
            ) : (
              <TableGrid data={data} big avail={avail || undefined} />
            )}
          </View>
        </ScrollView>
      ) : (
        <View style={styles.empty}>
          <EmptyState icon="table" title={t('chat.expired')} message={t('chat.expiredHint')} />
        </View>
      )}
      <SidewaysTable
        data={data ?? null}
        title={title ? String(title) : t('chat.table')}
        visible={sideways}
        onClose={() => setSideways(false)}
      />
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
